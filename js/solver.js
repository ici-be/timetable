/**
 * Moteur de résolution d'horaires sous contraintes (CSP + Recherche Locale Guidée)
 * Gère les règles génériques (hard & soft), les désidératas (imposés et interdits),
 * la génération de variantes ("Autre proposition") et l'analyse des changements par case.
 */

import {
  resolveTargetTypeIds,
  resolveTargetMemberIds,
  matchesDayFilter
} from './rules-schema.js';

/**
 * Générateur pseudo-aléatoire déterministe (Mulberry32) pour reproductibilité et variantes.
 */
function createRNG(seed = 1) {
  let a = (seed >>> 0) || 1;
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithRNG(arr, rng) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Construit les métadonnées des dates de la période.
 */
export function buildDateMetadata(dateISOs) {
  return dateISOs.map((iso, idx) => {
    const [y, m, d] = iso.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d, 12, 0, 0);
    const dow = dateObj.getDay(); // 0=Dim, 1=Lun..6=Sam
    const isWeekend = dow === 0 || dow === 6;
    // Calcul d'un index de semaine (regroupé du Lundi au Dimanche)
    const weekIndex = Math.floor(idx / 7);
    return {
      iso,
      idx,
      dateObj,
      dow,
      isWeekend,
      weekIndex
    };
  });
}

/**
 * Pré-compile les règles actives pour une évaluation ultra-rapide.
 */
export function compileRules(rules, dayTypes, members, dateMeta) {
  const activeRules = (rules || []).filter(r => r && r.enabled !== false);
  return activeRules.map(rule => {
    const p = rule.params || {};
    const targetTypeSet = new Set(resolveTargetTypeIds(p.targetTypes, dayTypes));
    const triggerTypeSet = new Set(resolveTargetTypeIds(p.triggerTypes, dayTypes));
    const groupATypeSet = new Set(resolveTargetTypeIds(p.groupATypes, dayTypes));
    const groupBTypeSet = new Set(resolveTargetTypeIds(p.groupBTypes, dayTypes));
    const targetMemberSet = new Set(resolveTargetMemberIds(p.targetMembers, members));
    const matchingDayIdxs = dateMeta
      .filter(dm => matchesDayFilter(dm.dateObj, p.dayFilter))
      .map(dm => dm.idx);

    return {
      rule,
      kind: rule.kind,
      severity: rule.severity || 'hard',
      weight: Number(rule.weight) || (rule.severity === 'soft' ? 50 : 100),
      params: p,
      targetTypeSet,
      triggerTypeSet,
      groupATypeSet,
      groupBTypeSet,
      targetMemberSet,
      matchingDayIdxs
    };
  });
}

/**
 * Détermine pour chaque (dateIdx, memberId) les types de journées autorisés (domaine)
 * en tenant compte de la typologie (semaine/weekend), des désidératas et des règles unaires / transitions fixes.
 */
export function computeDomains(dateMeta, members, dayTypes, desiderata, compiledRules) {
  const defaultWeekendRest = dayTypes.find(dt => dt.isDefaultRest) || dayTypes.find(dt => dt.id === 'REPOS') || dayTypes[dayTypes.length - 1];
  const defaultWeekdayWork = dayTypes.find(dt => dt.id === 'BUREAU') || dayTypes.find(dt => dt.autoAssign && dt.dayScope !== 'weekend') || dayTypes[0];

  // Types qui peuvent être requis par une règle d'enchaînement
  const ruleRequiredTypes = new Set();
  for (const cr of compiledRules) {
    if (cr.kind === 'sequence_transition' && cr.params.mode === 'require') {
      cr.targetTypeSet.forEach(t => ruleRequiredTypes.add(t));
    }
  }

  const domains = {}; // key: `${dateIso}__${memberId}` -> string[] (typeIds)

  for (const dm of dateMeta) {
    for (const member of members) {
      const key = `${dm.iso}__${member.id}`;
      const des = desiderata?.[key];

      // 1. Si un désidérata impose un type précis, le domaine est fixé à ce seul type
      if (des && des.requiredType) {
        domains[key] = [des.requiredType];
        continue;
      }

      // 2. Sinon, partir des types compatibles avec le jour (semaine vs weekend)
      let allowed = dayTypes.filter(dt => {
        if (dm.isWeekend) {
          if (dt.dayScope === 'weekday') return false;
          return dt.autoAssign || dt.isDefaultRest || dt.id === defaultWeekendRest?.id;
        } else {
          if (dt.dayScope === 'weekend') return false;
          return dt.autoAssign || ruleRequiredTypes.has(dt.id);
        }
      }).map(dt => dt.id);

      // 3. Retirer les types interdits par le désidérata du membre ce jour-là
      if (des && Array.isArray(des.forbiddenTypes) && des.forbiddenTypes.length > 0) {
        const forbidSet = new Set(des.forbiddenTypes);
        allowed = allowed.filter(t => !forbidSet.has(t));
      }

      // 4. Appliquer les règles récurrentes par jour de semaine (member_day_restriction)
      for (const cr of compiledRules) {
        if (cr.kind === 'member_day_restriction' && cr.severity === 'hard') {
          if (!cr.targetMemberSet.has(member.id)) continue;
          const dows = (cr.params.daysOfWeek || []).map(d => (Number(d) === 7 ? 0 : Number(d)));
          if (dows.includes(dm.dow)) {
            if (cr.params.mode === 'forbid') {
              allowed = allowed.filter(t => !cr.targetTypeSet.has(t));
            } else if (cr.params.mode === 'require') {
              const req = allowed.filter(t => cr.targetTypeSet.has(t));
              if (req.length > 0) allowed = req;
            }
          }
        }
      }

      // Garantir au moins un type de repli pour éviter un domaine vide
      if (allowed.length === 0) {
        if (des && Array.isArray(des.forbiddenTypes)) {
          const fallback = dayTypes.find(dt => !des.forbiddenTypes.includes(dt.id));
          allowed = [fallback ? fallback.id : (dm.isWeekend ? defaultWeekendRest.id : defaultWeekdayWork.id)];
        } else {
          allowed = [dm.isWeekend ? defaultWeekendRest.id : defaultWeekdayWork.id];
        }
      }

      domains[key] = allowed;
    }
  }

  // 5. Pré-appliquer les transitions strictes déclenchées par des absences fixées (ex: Congé > 2j, Maladie)
  for (const cr of compiledRules) {
    if (cr.kind !== 'sequence_transition' || cr.severity !== 'hard') continue;
    const minStreak = Math.max(1, Number(cr.params.minTriggerStreak) || 1);
    const dir = (cr.params.direction === 'before' || Number(cr.params.offsetDays) < 0) ? 'before' : 'after';
    const seqDays = cr.params.skipWeekends !== false ? dateMeta.filter(d => !d.isWeekend) : dateMeta;

    for (const member of members) {
      if (!cr.targetMemberSet.has(member.id)) continue;
      let i = 0;
      while (i < seqDays.length) {
        const dom = domains[`${seqDays[i].iso}__${member.id}`];
        if (dom.length === 1 && cr.triggerTypeSet.has(dom[0])) {
          let j = i;
          while (
            j + 1 < seqDays.length &&
            domains[`${seqDays[j + 1].iso}__${member.id}`].length === 1 &&
            cr.triggerTypeSet.has(domains[`${seqDays[j + 1].iso}__${member.id}`][0])
          ) {
            j++;
          }
          const runLen = j - i + 1;
          if (runLen >= minStreak) {
            const targetPos = dir === 'before' ? i - 1 : j + 1;
            if (targetPos >= 0 && targetPos < seqDays.length) {
              const targetKey = `${seqDays[targetPos].iso}__${member.id}`;
              const curDom = domains[targetKey];
              if (curDom.length > 1) {
                const filtered = cr.params.mode === 'forbid'
                  ? curDom.filter(t => !cr.targetTypeSet.has(t))
                  : curDom.filter(t => cr.targetTypeSet.has(t));
                if (filtered.length > 0) {
                  domains[targetKey] = filtered;
                }
              }
            }
          }
          i = j + 1;
        } else {
          i++;
        }
      }
    }
  }

  return domains;
}

/**
 * Évalue complètement une grille d'horaires (`grid[dateIso][memberId] = typeId`)
 * par rapport à toutes les règles compilées et aux désidératas.
 */
export function evaluateSchedule(grid, dateMeta, members, dayTypes, desiderata, compiledRules) {
  const violations = [];
  let hardPenalty = 0;
  let softPenalty = 0;

  const workingTypeSet = new Set(dayTypes.filter(dt => dt.isWorkingDay).map(dt => dt.id));

  // Vérification des désidératas
  for (const dm of dateMeta) {
    for (const m of members) {
      const key = `${dm.iso}__${m.id}`;
      const des = desiderata?.[key];
      const assigned = grid[dm.iso]?.[m.id];
      if (!des || !assigned) continue;

      if (des.requiredType && assigned !== des.requiredType) {
        hardPenalty += 1000;
        violations.push({
          severity: 'hard',
          ruleId: 'desiderata',
          ruleName: 'Désidérata obligatoire',
          dateIso: dm.iso,
          memberId: m.id,
          message: `${m.name} a demandé "${des.requiredType}" le ${formatDateShort(dm.iso)}.`
        });
      }
      if (Array.isArray(des.forbiddenTypes) && des.forbiddenTypes.includes(assigned)) {
        hardPenalty += 1000;
        violations.push({
          severity: 'hard',
          ruleId: 'desiderata',
          ruleName: 'Désidérata (interdiction)',
          dateIso: dm.iso,
          memberId: m.id,
          message: `${m.name} ne souhaite pas "${assigned}" le ${formatDateShort(dm.iso)}.`
        });
      }
    }
  }

  // Regroupement des dates par semaine
  const weeksMap = new Map();
  for (const dm of dateMeta) {
    if (!weeksMap.has(dm.weekIndex)) weeksMap.set(dm.weekIndex, []);
    weeksMap.get(dm.weekIndex).push(dm);
  }

  // Évaluation de chaque règle
  for (const cr of compiledRules) {
    const {
      rule,
      kind,
      severity,
      weight,
      params,
      targetTypeSet,
      triggerTypeSet,
      groupATypeSet,
      groupBTypeSet,
      targetMemberSet,
      matchingDayIdxs
    } = cr;

    const addViolation = (amount, dateIso, memberId, message) => {
      if (severity === 'hard') {
        hardPenalty += weight * amount;
      } else {
        softPenalty += weight * amount;
      }
      violations.push({
        severity,
        ruleId: rule.id,
        ruleName: rule.name,
        dateIso: dateIso || null,
        memberId: memberId || null,
        message
      });
    };

    switch (kind) {
      case 'daily_headcount': {
        for (const dIdx of matchingDayIdxs) {
          const dm = dateMeta[dIdx];
          let count = 0;
          for (const m of members) {
            const t = grid[dm.iso]?.[m.id];
            if (targetTypeSet.has(t)) count++;
          }
          if (params.min !== null && params.min !== undefined && count < params.min) {
            const diff = params.min - count;
            addViolation(
              diff,
              dm.iso,
              null,
              `${formatDateShort(dm.iso)} : ${count} personne(s) au lieu de min. ${params.min} (${rule.name})`
            );
          }
          if (params.max !== null && params.max !== undefined && count > params.max) {
            const diff = count - params.max;
            addViolation(
              diff,
              dm.iso,
              null,
              `${formatDateShort(dm.iso)} : ${count} personne(s) au lieu de max. ${params.max} (${rule.name})`
            );
          }
        }
        break;
      }

      case 'member_period_count': {
        const periods = params.period === 'horizon' ? [dateMeta] : Array.from(weeksMap.values());
        for (const periodDays of periods) {
          const filteredDays = periodDays.filter(dm => matchesDayFilter(dm.dateObj, params.dayFilter));
          if (filteredDays.length === 0) continue;

          for (const m of members) {
            if (!targetMemberSet.has(m.id)) continue;
            let count = 0;
            let workingDaysInPeriod = 0;
            for (const dm of filteredDays) {
              const t = grid[dm.iso]?.[m.id];
              if (targetTypeSet.has(t)) count++;
              if (workingTypeSet.has(t) || targetTypeSet.has(t)) workingDaysInPeriod++;
            }

            if (params.min !== null && params.min !== undefined) {
              // Ajuster le minimum au nombre de jours ouvrés réellement travaillés (hors congés/maladies)
              const effectiveMin = Math.min(params.min, workingDaysInPeriod);
              if (count < effectiveMin) {
                addViolation(
                  effectiveMin - count,
                  filteredDays[0].iso,
                  m.id,
                  `${m.name} (sem. du ${formatDateShort(filteredDays[0].iso)}) : ${count} j. au lieu de min. ${effectiveMin} (${rule.name})`
                );
              }
            }
            if (params.max !== null && params.max !== undefined && count > params.max) {
              addViolation(
                count - params.max,
                filteredDays[0].iso,
                m.id,
                `${m.name} (sem. du ${formatDateShort(filteredDays[0].iso)}) : ${count} j. au lieu de max. ${params.max} (${rule.name})`
              );
            }
          }
        }
        break;
      }

      case 'sequence_transition': {
        const minStreak = Math.max(1, Number(params.minTriggerStreak) || 1);
        const dir = (params.direction === 'before' || Number(params.offsetDays) < 0) ? 'before' : 'after';
        const seqDays = params.skipWeekends !== false ? dateMeta.filter(d => !d.isWeekend) : dateMeta;

        for (const m of members) {
          if (!targetMemberSet.has(m.id)) continue;
          let i = 0;
          while (i < seqDays.length) {
            const tNow = grid[seqDays[i].iso]?.[m.id];
            if (triggerTypeSet.has(tNow)) {
              let j = i;
              while (j + 1 < seqDays.length && triggerTypeSet.has(grid[seqDays[j + 1].iso]?.[m.id])) {
                j++;
              }
              const runLen = j - i + 1;
              if (runLen >= minStreak) {
                const targetPos = dir === 'before' ? i - 1 : j + 1;
                if (targetPos >= 0 && targetPos < seqDays.length) {
                  const dmTarget = seqDays[targetPos];
                  const tTarget = grid[dmTarget.iso]?.[m.id];
                  if (params.mode === 'forbid' && targetTypeSet.has(tTarget)) {
                    addViolation(
                      1.5,
                      dmTarget.iso,
                      m.id,
                      `${m.name} (${formatDateShort(dmTarget.iso)}) : "${tTarget}" interdit ${dir === 'before' ? 'avant' : 'après'} ${runLen} j. de "${tNow}" (${rule.name})`
                    );
                  } else if (params.mode === 'require' && !targetTypeSet.has(tTarget)) {
                    addViolation(
                      1.5,
                      dmTarget.iso,
                      m.id,
                      `${m.name} (${formatDateShort(dmTarget.iso)}) : doit être en [${Array.from(targetTypeSet).join('/')}] ${dir === 'before' ? 'avant' : 'après'} "${tNow}" (${rule.name})`
                    );
                  }
                }
              }
              i = j + 1;
            } else {
              i++;
            }
          }
        }
        break;
      }

      case 'daily_balance': {
        for (const dIdx of matchingDayIdxs) {
          const dm = dateMeta[dIdx];
          let countA = 0;
          let countB = 0;
          for (const m of members) {
            const t = grid[dm.iso]?.[m.id];
            if (groupATypeSet.has(t)) countA++;
            else if (groupBTypeSet.has(t)) countB++;
          }
          const diff = Math.abs(countA - countB);
          // Pénalité quadratique pour favoriser à la fois l'équilibre Bureau/TT chaque jour et le lissage sur la semaine
          softPenalty += (diff * diff) * (weight * 0.16);
        }
        break;
      }

      case 'max_consecutive_days': {
        const maxC = Number(params.maxConsecutive) || 2;
        for (const m of members) {
          if (!targetMemberSet.has(m.id)) continue;
          let streak = 0;
          for (const dm of dateMeta) {
            if (params.skipWeekends && dm.isWeekend) continue;
            const t = grid[dm.iso]?.[m.id];
            if (targetTypeSet.has(t)) {
              streak++;
              if (streak > maxC) {
                addViolation(
                  1,
                  dm.iso,
                  m.id,
                  `${m.name} (${formatDateShort(dm.iso)}) : ${streak} jours consécutifs > max ${maxC} (${rule.name})`
                );
              }
            } else {
              streak = 0;
            }
          }
        }
        break;
      }

      case 'weekend_pair_consistency': {
        for (let dIdx = 0; dIdx < dateMeta.length - 1; dIdx++) {
          const dmSat = dateMeta[dIdx];
          const dmSun = dateMeta[dIdx + 1];
          if (dmSat.dow === 6 && dmSun.dow === 0) {
            for (const m of members) {
              const hasSat = targetTypeSet.has(grid[dmSat.iso]?.[m.id]);
              const hasSun = targetTypeSet.has(grid[dmSun.iso]?.[m.id]);
              if (hasSat !== hasSun) {
                addViolation(
                  2,
                  dmSun.iso,
                  m.id,
                  `${m.name} (${formatDateShort(dmSat.iso)}-${formatDateShort(dmSun.iso)}) : weekend coupé (${rule.name})`
                );
              }
            }
          }
        }
        break;
      }

      case 'max_consecutive_weekends': {
        const maxW = Math.max(1, Number(params.maxConsecutiveWeekends) || 1);
        // Regrouper les paires (Samedi, Dimanche) consécutives
        const weekendPairs = [];
        for (let dIdx = 0; dIdx < dateMeta.length - 1; dIdx++) {
          const dmSat = dateMeta[dIdx];
          const dmSun = dateMeta[dIdx + 1];
          if (dmSat.dow === 6 && dmSun.dow === 0) {
            weekendPairs.push({ sat: dmSat, sun: dmSun });
          }
        }

        for (const m of members) {
          if (!targetMemberSet.has(m.id)) continue;
          let streak = 0;
          for (const pair of weekendPairs) {
            const tSat = grid[pair.sat.iso]?.[m.id];
            const tSun = grid[pair.sun.iso]?.[m.id];
            // Est en service si au moins un des deux jours n'est PAS du repos/congé (ou est dans workingTypeSet)
            // Par défaut targetTypes = ['REPOS']. Si tSat n'est pas dans targetTypes ou tSun n'est pas dans targetTypes => service
            const isWorkingSat = targetTypeSet.size > 0 ? !targetTypeSet.has(tSat) : workingTypeSet.has(tSat);
            const isWorkingSun = targetTypeSet.size > 0 ? !targetTypeSet.has(tSun) : workingTypeSet.has(tSun);
            const isServiceThisWeekend = isWorkingSat || isWorkingSun;

            if (isServiceThisWeekend) {
              streak++;
              if (streak > maxW) {
                addViolation(
                  2,
                  pair.sun.iso,
                  m.id,
                  `${m.name} (${formatDateShort(pair.sat.iso)}-${formatDateShort(pair.sun.iso)}) : service sur ${streak} weekends consécutifs (max: ${maxW}) (${rule.name})`
                );
              }
            } else {
              streak = 0;
            }
          }
        }
        break;
      }

      case 'member_day_restriction': {
        const dows = (params.daysOfWeek || []).map(d => (Number(d) === 7 ? 0 : Number(d)));
        for (const dm of dateMeta) {
          if (!dows.includes(dm.dow)) continue;
          for (const m of members) {
            if (!targetMemberSet.has(m.id)) continue;
            const t = grid[dm.iso]?.[m.id];
            if (params.mode === 'forbid' && targetTypeSet.has(t)) {
              addViolation(
                1,
                dm.iso,
                m.id,
                `${m.name} (${formatDateShort(dm.iso)}) : "${t}" interdit ce jour de la semaine (${rule.name})`
              );
            } else if (params.mode === 'require' && !targetTypeSet.has(t)) {
              addViolation(
                1,
                dm.iso,
                m.id,
                `${m.name} (${formatDateShort(dm.iso)}) : "${t}" ne respecte pas l'obligation du jour (${rule.name})`
              );
            }
          }
        }
        break;
      }

      case 'member_compatibility': {
        const targetMembersArr = members.filter(m => targetMemberSet.has(m.id));
        if (targetMembersArr.length >= 2) {
          for (const dIdx of matchingDayIdxs) {
            const dm = dateMeta[dIdx];
            const matchingCount = targetMembersArr.filter(m => targetTypeSet.has(grid[dm.iso]?.[m.id])).length;
            if (params.mode === 'not_together' && matchingCount > 1) {
              addViolation(
                matchingCount - 1,
                dm.iso,
                null,
                `${formatDateShort(dm.iso)} : ${targetMembersArr.map(m => m.name).join(' & ')} ne peuvent pas avoir ce type simultanément (${rule.name})`
              );
            } else if (params.mode === 'together' && matchingCount > 0 && matchingCount < targetMembersArr.length) {
              addViolation(
                1,
                dm.iso,
                null,
                `${formatDateShort(dm.iso)} : ${targetMembersArr.map(m => m.name).join(' & ')} doivent avoir ce type ensemble (${rule.name})`
              );
            } else if (params.mode === 'at_least_one' && matchingCount === 0) {
              addViolation(
                1,
                dm.iso,
                null,
                `${formatDateShort(dm.iso)} : au moins un parmi ${targetMembersArr.map(m => m.name).join(', ')} requis (${rule.name})`
              );
            }
          }
        }
        break;
      }

      case 'fairness_balance': {
        const targetMembersArr = members.filter(m => targetMemberSet.has(m.id));
        if (targetMembersArr.length >= 2) {
          // 1. Équité stricte par type individuel (ex: même nombre de Perm. Matin, même nombre de Perm. Midi, même nombre de Perm. Soir)
          for (const typeId of targetTypeSet) {
            const counts = targetMembersArr.map(m => {
              let c = 0;
              for (const dm of dateMeta) {
                if (grid[dm.iso]?.[m.id] === typeId) c++;
              }
              return c;
            });
            const maxC = Math.max(...counts);
            const minC = Math.min(...counts);
            const spread = maxC - minC;
            const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
            const sumSqDiff = counts.reduce((acc, c) => acc + (c - mean) * (c - mean), 0);

            if (spread > 0) {
              softPenalty += spread * (weight * 0.9) + sumSqDiff * (weight * 0.5);
            }
          }
          // 2. Équité sur le total combiné des types ciblés
          if (targetTypeSet.size > 1) {
            const totalCounts = targetMembersArr.map(m => {
              let c = 0;
              for (const dm of dateMeta) {
                if (targetTypeSet.has(grid[dm.iso]?.[m.id])) c++;
              }
              return c;
            });
            const spreadTotal = Math.max(...totalCounts) - Math.min(...totalCounts);
            const meanTotal = totalCounts.reduce((a, b) => a + b, 0) / totalCounts.length;
            const sumSqTotal = totalCounts.reduce((acc, c) => acc + (c - meanTotal) * (c - meanTotal), 0);
            if (spreadTotal > 0) {
              softPenalty += spreadTotal * (weight * 0.8) + sumSqTotal * (weight * 0.45);
            }
          }
        }
        break;
      }
    }
  }

  return {
    hardPenalty,
    softPenalty,
    totalCost: hardPenalty * 1000 + softPenalty,
    violations,
    hardViolations: violations.filter(v => v.severity === 'hard'),
    softViolations: violations.filter(v => v.severity === 'soft')
  };
}

function formatDateShort(iso) {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

function cloneGrid(grid) {
  const copy = {};
  for (const iso of Object.keys(grid)) {
    copy[iso] = { ...grid[iso] };
  }
  return copy;
}

/**
 * Construit une grille initiale intelligente (heuristique constructive) avant l'optimisation locale.
 */
function buildConstructiveInitialGrid(dateMeta, members, dayTypes, domains, compiledRules, rng) {
  const grid = {};
  for (const dm of dateMeta) {
    grid[dm.iso] = {};
  }

  const defaultWeekendRest = (dayTypes.find(dt => dt.isDefaultRest) || dayTypes.find(dt => dt.id === 'REPOS') || dayTypes[dayTypes.length - 1])?.id;
  const defaultWeekdayWork = (dayTypes.find(dt => dt.id === 'BUREAU') || dayTypes.find(dt => dt.autoAssign && dt.dayScope !== 'weekend') || dayTypes[0])?.id;

  const officeTypeIds = new Set(
    dayTypes.filter(dt => dt.id === 'BUREAU' || (Array.isArray(dt.tags) && dt.tags.includes('bureau'))).map(dt => dt.id)
  );
  if (defaultWeekdayWork) officeTypeIds.add(defaultWeekdayWork);

  // Compteurs d'équité par membre et par type
  const memberTypeCounts = {};
  for (const m of members) {
    memberTypeCounts[m.id] = {};
    for (const dt of dayTypes) memberTypeCounts[m.id][dt.id] = 0;
  }

  // 1. Affecter tous les domaines à 1 seule valeur (désidératas imposés)
  for (const dm of dateMeta) {
    for (const m of members) {
      const dom = domains[`${dm.iso}__${m.id}`];
      if (dom.length === 1) {
        grid[dm.iso][m.id] = dom[0];
        memberTypeCounts[m.id][dom[0]] = (memberTypeCounts[m.id][dom[0]] || 0) + 1;
      }
    }
  }

  // 2. Planifier les weekends
  for (const dm of dateMeta) {
    if (!dm.isWeekend) continue;
    for (const m of members) {
      if (!grid[dm.iso][m.id]) {
        const dom = domains[`${dm.iso}__${m.id}`];
        grid[dm.iso][m.id] = dom.includes(defaultWeekendRest) ? defaultWeekendRest : dom[0];
      }
    }
  }

  // 3. Identifier les types à quota journalier exact (ex: 1 Bur. Matin, 1 Bur. Midi, 1 Bur. Soir)
  const weekdaysAll = dateMeta.filter(d => !d.isWeekend);
  const exactDailyTypes = [];
  for (const cr of compiledRules) {
    if (
      cr.kind === 'daily_headcount' &&
      cr.params.min !== null &&
      cr.params.max !== null &&
      cr.params.min === cr.params.max &&
      cr.targetTypeSet.size === 1
    ) {
      const tId = Array.from(cr.targetTypeSet)[0];
      if (!exactDailyTypes.includes(tId)) exactDailyTypes.push(tId);
    }
  }

  // Calculer le nombre de jours ouvrés disponibles par membre sur l'ensemble de la période
  const availWeekdaysCount = {};
  for (const m of members) {
    availWeekdaysCount[m.id] = weekdaysAll.filter(dm => !grid[dm.iso][m.id]).length;
  }

  // 4. Planifier les jours de semaine semaine par semaine
  const weeksMap = new Map();
  for (const dm of dateMeta) {
    if (!weeksMap.has(dm.weekIndex)) weeksMap.set(dm.weekIndex, []);
    weeksMap.get(dm.weekIndex).push(dm);
  }

  const weeklyQuotaRules = compiledRules.filter(cr => cr.kind === 'member_period_count' && cr.params.period === 'week');
  const maxTTRule = weeklyQuotaRules.find(cr => cr.params.max !== null && cr.params.max !== undefined && cr.targetTypeSet.has('TT'));
  const maxTTPerWeek = maxTTRule ? maxTTRule.params.max : 2;
  const minBureauWeekRule = weeklyQuotaRules.find(cr => cr.params.min !== null && cr.params.min > 0 && cr.targetTypeSet.has(defaultWeekdayWork));
  const minBureauPerWeek = minBureauWeekRule ? minBureauWeekRule.params.min : 2;

  for (const weekDays of weeksMap.values()) {
    const weekdays = weekDays.filter(d => !d.isWeekend);

    // 4a. Attribuer d'abord les permanences quotidiennes (BUREAU_MATIN, BUREAU_MIDI, BUREAU_SOIR)
    // en priorisant les membres ayant le moins de cette permanence, puis le moins de permanences au total,
    // puis ceux ayant le moins de jours ouvrés disponibles (ex: en congé une partie de la semaine).
    for (const dm of weekdays) {
      const exactDailyRules = compiledRules.filter(
        cr => cr.kind === 'daily_headcount' &&
          cr.matchingDayIdxs.includes(dm.idx) &&
          cr.params.min !== null &&
          cr.params.max !== null &&
          cr.params.min === cr.params.max &&
          cr.targetTypeSet.size === 1
      );

      for (const edr of exactDailyRules) {
        const targetType = Array.from(edr.targetTypeSet)[0];
        const needed = edr.params.min;
        let current = members.filter(m => grid[dm.iso][m.id] === targetType).length;

        const candidates = shuffleWithRNG(members, rng)
          .filter(m => !grid[dm.iso][m.id] && domains[`${dm.iso}__${m.id}`].includes(targetType))
          .sort((a, b) => {
            const countA = memberTypeCounts[a.id][targetType] || 0;
            const countB = memberTypeCounts[b.id][targetType] || 0;
            if (countA !== countB) return countA - countB;

            const totalPermA = exactDailyTypes.reduce((acc, t) => acc + (memberTypeCounts[a.id][t] || 0), 0);
            const totalPermB = exactDailyTypes.reduce((acc, t) => acc + (memberTypeCounts[b.id][t] || 0), 0);
            if (totalPermA !== totalPermB) return totalPermA - totalPermB;

            return (availWeekdaysCount[a.id] || 0) - (availWeekdaysCount[b.id] || 0);
          });

        for (const cand of candidates) {
          if (current >= needed) break;
          grid[dm.iso][cand.id] = targetType;
          memberTypeCounts[cand.id][targetType] = (memberTypeCounts[cand.id][targetType] || 0) + 1;
          current++;
        }
      }
    }

    // 4b. Attribuer ensuite TT vs BUREAU sur chaque jour de la semaine de façon équilibrée
    for (let wDayPos = 0; wDayPos < weekdays.length; wDayPos++) {
      const dm = weekdays[wDayPos];
      const remainingWeekdaysAfterToday = weekdays.slice(wDayPos + 1);

      const minBureauRule = compiledRules.find(
        cr => cr.kind === 'daily_headcount' &&
          cr.matchingDayIdxs.includes(dm.idx) &&
          cr.targetTypeSet.has(defaultWeekdayWork) &&
          cr.params.min > 0
      );
      const minBureauToday = minBureauRule ? minBureauRule.params.min : 4;

      // Compter les personnes déjà au bureau (ex: les 3 permanences) et les personnes travaillant aujourd'hui
      const workingTodayCount = members.filter(m => {
        const fixed = grid[dm.iso][m.id];
        if (!fixed) return true;
        return officeTypeIds.has(fixed) || fixed === 'TT';
      }).length;

      // Cible idéale de TT aujourd'hui : équilibrer Bureau et TT tout en respectant minBureauToday et le quota hebdo
      const targetTTToday = Math.max(
        0,
        Math.min(
          workingTodayCount - minBureauToday,
          Math.floor(workingTodayCount / 2)
        )
      );

      let currentTTToday = members.filter(m => grid[dm.iso][m.id] === 'TT').length;

      const unassigned = shuffleWithRNG(members, rng).filter(m => !grid[dm.iso][m.id]);

      // Trier les candidats pour le TT : ceux qui ont eu le moins de TT cette semaine et sur la période
      unassigned.sort((a, b) => {
        const ttWeekA = weekdays.reduce((acc, d) => acc + (grid[d.iso][a.id] === 'TT' ? 1 : 0), 0);
        const ttWeekB = weekdays.reduce((acc, d) => acc + (grid[d.iso][b.id] === 'TT' ? 1 : 0), 0);
        if (ttWeekA !== ttWeekB) return ttWeekA - ttWeekB;
        return (memberTypeCounts[a.id]['TT'] || 0) - (memberTypeCounts[b.id]['TT'] || 0);
      });

      for (const m of unassigned) {
        const dom = domains[`${dm.iso}__${m.id}`];
        const ttInWeek = weekdays.reduce((acc, d) => acc + (grid[d.iso][m.id] === 'TT' ? 1 : 0), 0);
        const bureauInWeek = weekdays.reduce((acc, d) => acc + (officeTypeIds.has(grid[d.iso][m.id]) ? 1 : 0), 0);
        const futureAvailDays = remainingWeekdaysAfterToday.filter(d => {
          const fDom = domains[`${d.iso}__${m.id}`];
          return fDom.some(t => officeTypeIds.has(t));
        }).length;
        const totalWorkingDaysInWeek = weekdays.filter(d => {
          const fDom = domains[`${d.iso}__${m.id}`];
          return fDom.some(t => officeTypeIds.has(t) || t === 'TT');
        }).length;
        const neededMinBureau = Math.min(minBureauPerWeek, totalWorkingDaysInWeek);

        const canTakeTT =
          dom.includes('TT') &&
          ttInWeek < maxTTPerWeek &&
          currentTTToday < targetTTToday &&
          (bureauInWeek + futureAvailDays >= neededMinBureau);

        if (canTakeTT) {
          grid[dm.iso][m.id] = 'TT';
          memberTypeCounts[m.id]['TT'] = (memberTypeCounts[m.id]['TT'] || 0) + 1;
          currentTTToday++;
        } else if (dom.includes(defaultWeekdayWork)) {
          grid[dm.iso][m.id] = defaultWeekdayWork;
          memberTypeCounts[m.id][defaultWeekdayWork] = (memberTypeCounts[m.id][defaultWeekdayWork] || 0) + 1;
        } else {
          const fallback = dom[0];
          grid[dm.iso][m.id] = fallback;
          memberTypeCounts[m.id][fallback] = (memberTypeCounts[m.id][fallback] || 0) + 1;
        }
      }
    }
  }

  return grid;
}

/**
 * Calcule un bonus de diversité par rapport à une proposition précédente
 * pour que le bouton "Autre variante" propose un horaire réellement différent.
 */
function computeSimilarityPenalty(grid, previousGrid, dateMeta, members) {
  if (!previousGrid) return 0;
  let sameCells = 0;
  let totalMutable = 0;
  for (const dm of dateMeta) {
    for (const m of members) {
      if (grid[dm.iso]?.[m.id] && previousGrid[dm.iso]?.[m.id]) {
        totalMutable++;
        if (grid[dm.iso][m.id] === previousGrid[dm.iso][m.id]) {
          sameCells++;
        }
      }
    }
  }
  if (totalMutable === 0) return 0;
  const ratio = sameCells / totalMutable;
  return ratio * 35;
}

/**
 * Génère une proposition d'horaire optimale respectant les règles et les désidératas.
 */
export function generateSchedule({
  dateISOs,
  members,
  dayTypes,
  rules,
  desiderata = {},
  seed = Date.now(),
  previousGrid = null,
  maxIterations = 2400
}) {
  const activeMembers = members.filter(m => m.active !== false);
  const dateMeta = buildDateMetadata(dateISOs);
  const compiledRules = compileRules(rules, dayTypes, activeMembers, dateMeta);
  const domains = computeDomains(dateMeta, activeMembers, dayTypes, desiderata, compiledRules);

  const weekdaysMeta = dateMeta.filter(d => !d.isWeekend);
  const exactDailyTypeSet = new Set();
  for (const cr of compiledRules) {
    if (
      cr.kind === 'daily_headcount' &&
      cr.params.min !== null &&
      cr.params.max !== null &&
      cr.params.min === cr.params.max &&
      cr.targetTypeSet.size === 1
    ) {
      cr.targetTypeSet.forEach(t => exactDailyTypeSet.add(t));
    }
  }

  let globalBestGrid = null;
  let globalBestEval = null;
  let globalBestObjective = Infinity;

  const starts = 3;
  const iterPerStart = Math.floor(maxIterations / starts);

  for (let s = 0; s < starts; s++) {
    const rng = createRNG(seed + s * 7919);
    let currentGrid = buildConstructiveInitialGrid(dateMeta, activeMembers, dayTypes, domains, compiledRules, rng);
    let currentEval = evaluateSchedule(currentGrid, dateMeta, activeMembers, dayTypes, desiderata, compiledRules);
    let currentSimPenalty = computeSimilarityPenalty(currentGrid, previousGrid, dateMeta, activeMembers);
    let currentObj = currentEval.totalCost + currentSimPenalty;

    if (currentObj < globalBestObjective) {
      globalBestObjective = currentObj;
      globalBestGrid = cloneGrid(currentGrid);
      globalBestEval = currentEval;
    }

    for (let iter = 0; iter < iterPerStart; iter++) {
      const temperature = Math.max(0.3, (1 - iter / iterPerStart) * 12);
      const moveRoll = rng();

      // Choisir un jour ouvré principalement
      let dm;
      if (currentEval.hardViolations.length > 0 && rng() < 0.6) {
        const v = currentEval.hardViolations[Math.floor(rng() * currentEval.hardViolations.length)];
        dm = dateMeta.find(d => d.iso === v.dateIso) || weekdaysMeta[Math.floor(rng() * weekdaysMeta.length)] || dateMeta[0];
      } else if (weekdaysMeta.length > 0) {
        dm = weekdaysMeta[Math.floor(rng() * weekdaysMeta.length)];
      } else {
        dm = dateMeta[Math.floor(rng() * dateMeta.length)];
      }

      // Mouvement 1 (45% du temps) : Échanger les affectations de 2 membres le même jour (préserve les quotas journaliers)
      if (moveRoll < 0.45 && activeMembers.length >= 2) {
        const m1 = activeMembers[Math.floor(rng() * activeMembers.length)];
        const m2 = activeMembers[Math.floor(rng() * activeMembers.length)];
        if (m1.id === m2.id) continue;

        const t1 = currentGrid[dm.iso][m1.id];
        const t2 = currentGrid[dm.iso][m2.id];
        if (t1 === t2) continue;

        if (domains[`${dm.iso}__${m1.id}`].includes(t2) && domains[`${dm.iso}__${m2.id}`].includes(t1)) {
          currentGrid[dm.iso][m1.id] = t2;
          currentGrid[dm.iso][m2.id] = t1;

          const newEval = evaluateSchedule(currentGrid, dateMeta, activeMembers, dayTypes, desiderata, compiledRules);
          const newObj = newEval.totalCost + computeSimilarityPenalty(currentGrid, previousGrid, dateMeta, activeMembers);

          if (newObj <= currentObj || (newEval.hardPenalty <= currentEval.hardPenalty && rng() < Math.exp((currentObj - newObj) / temperature))) {
            currentEval = newEval;
            currentObj = newObj;
            if (currentObj < globalBestObjective) {
              globalBestObjective = currentObj;
              globalBestGrid = cloneGrid(currentGrid);
              globalBestEval = currentEval;
            }
          } else {
            currentGrid[dm.iso][m1.id] = t1;
            currentGrid[dm.iso][m2.id] = t2;
          }
        }
        continue;
      }

      // Mouvement 2 (30% du temps) : Échange croisé (AB / BA) entre 2 membres sur 2 jours ouvrés (préserve quotas journaliers ET totaux par membre !)
      if (moveRoll < 0.75 && weekdaysMeta.length >= 2 && activeMembers.length >= 2) {
        const dm2 = weekdaysMeta[Math.floor(rng() * weekdaysMeta.length)];
        if (dm.iso === dm2.iso) continue;

        const m1 = activeMembers[Math.floor(rng() * activeMembers.length)];
        const m2 = activeMembers[Math.floor(rng() * activeMembers.length)];
        if (m1.id === m2.id) continue;

        const t1Day1 = currentGrid[dm.iso][m1.id];
        const t2Day1 = currentGrid[dm.iso][m2.id];
        const t1Day2 = currentGrid[dm2.iso][m1.id];
        const t2Day2 = currentGrid[dm2.iso][m2.id];

        if (t1Day1 === t2Day1 || t1Day2 === t2Day2) continue;

        if (
          domains[`${dm.iso}__${m1.id}`].includes(t2Day1) &&
          domains[`${dm.iso}__${m2.id}`].includes(t1Day1) &&
          domains[`${dm2.iso}__${m1.id}`].includes(t2Day2) &&
          domains[`${dm2.iso}__${m2.id}`].includes(t1Day2)
        ) {
          currentGrid[dm.iso][m1.id] = t2Day1;
          currentGrid[dm.iso][m2.id] = t1Day1;
          currentGrid[dm2.iso][m1.id] = t2Day2;
          currentGrid[dm2.iso][m2.id] = t1Day2;

          const newEval = evaluateSchedule(currentGrid, dateMeta, activeMembers, dayTypes, desiderata, compiledRules);
          const newObj = newEval.totalCost + computeSimilarityPenalty(currentGrid, previousGrid, dateMeta, activeMembers);

          if (newObj <= currentObj || (newEval.hardPenalty <= currentEval.hardPenalty && rng() < Math.exp((currentObj - newObj) / temperature))) {
            currentEval = newEval;
            currentObj = newObj;
            if (currentObj < globalBestObjective) {
              globalBestObjective = currentObj;
              globalBestGrid = cloneGrid(currentGrid);
              globalBestEval = currentEval;
            }
          } else {
            currentGrid[dm.iso][m1.id] = t1Day1;
            currentGrid[dm.iso][m2.id] = t2Day1;
            currentGrid[dm2.iso][m1.id] = t1Day2;
            currentGrid[dm2.iso][m2.id] = t2Day2;
          }
        }
        continue;
      }

      // Mouvement 3 (20% du temps) : Échange intra-membre sur 2 jours ouvrés de la même semaine
      // (ex : TT lundi ↔ BUREAU vendredi). Préserve les quotas hebdomadaires par membre et les
      // permanences exactes, tout en modifiant les effectifs journaliers (lissage Bureau / TT).
      if (moveRoll < 0.95 && weekdaysMeta.length >= 2) {
        const sameWeek = weekdaysMeta.filter(d => d.iso !== dm.iso && d.weekIndex === dm.weekIndex);
        const pool = sameWeek.length > 0 ? sameWeek : weekdaysMeta.filter(d => d.iso !== dm.iso);
        if (pool.length > 0) {
          const dm2 = pool[Math.floor(rng() * pool.length)];
          const mm = activeMembers[Math.floor(rng() * activeMembers.length)];
          const ta = currentGrid[dm.iso][mm.id];
          const tb = currentGrid[dm2.iso][mm.id];
          if (
            ta !== tb &&
            !exactDailyTypeSet.has(ta) && !exactDailyTypeSet.has(tb) &&
            domains[`${dm.iso}__${mm.id}`].includes(tb) &&
            domains[`${dm2.iso}__${mm.id}`].includes(ta)
          ) {
            currentGrid[dm.iso][mm.id] = tb;
            currentGrid[dm2.iso][mm.id] = ta;
            const newEval = evaluateSchedule(currentGrid, dateMeta, activeMembers, dayTypes, desiderata, compiledRules);
            const newObj = newEval.totalCost + computeSimilarityPenalty(currentGrid, previousGrid, dateMeta, activeMembers);
            if (newObj <= currentObj || (newEval.hardPenalty <= currentEval.hardPenalty && rng() < Math.exp((currentObj - newObj) / temperature))) {
              currentEval = newEval;
              currentObj = newObj;
              if (currentObj < globalBestObjective) {
                globalBestObjective = currentObj;
                globalBestGrid = cloneGrid(currentGrid);
                globalBestEval = currentEval;
              }
            } else {
              currentGrid[dm.iso][mm.id] = ta;
              currentGrid[dm2.iso][mm.id] = tb;
            }
          }
          continue;
        }
      }

      // Mouvement 4 (reste) : Changer un membre entre BUREAU et TT (sans casser un quota exact de permanence)
      const m = activeMembers[Math.floor(rng() * activeMembers.length)];
      const dom = domains[`${dm.iso}__${m.id}`];
      if (dom.length <= 1) continue;

      const oldType = currentGrid[dm.iso][m.id];
      if (exactDailyTypeSet.has(oldType) && currentEval.hardPenalty === 0) continue;

      const candidates = dom.filter(t => t !== oldType && !exactDailyTypeSet.has(t));
      if (candidates.length === 0) continue;
      const newType = candidates[Math.floor(rng() * candidates.length)];

      currentGrid[dm.iso][m.id] = newType;
      const newEval = evaluateSchedule(currentGrid, dateMeta, activeMembers, dayTypes, desiderata, compiledRules);
      const newObj = newEval.totalCost + computeSimilarityPenalty(currentGrid, previousGrid, dateMeta, activeMembers);

      if (newObj <= currentObj || (newEval.hardPenalty <= currentEval.hardPenalty && rng() < Math.exp((currentObj - newObj) / temperature))) {
        currentEval = newEval;
        currentObj = newObj;
        if (currentObj < globalBestObjective) {
          globalBestObjective = currentObj;
          globalBestGrid = cloneGrid(currentGrid);
          globalBestEval = currentEval;
        }
      } else {
        currentGrid[dm.iso][m.id] = oldType;
      }
    }
  }

  const stats = computeScheduleStats(globalBestGrid, dateMeta, activeMembers, dayTypes);

  return {
    grid: globalBestGrid,
    evaluation: globalBestEval,
    stats,
    seed
  };
}

/**
 * Calcule les statistiques par membre et par jour pour l'affichage récapitulatif.
 */
export function computeScheduleStats(grid, dateMeta, members, dayTypes) {
  const officeTypeSet = new Set(
    dayTypes.filter(dt => dt.id === 'BUREAU' || (Array.isArray(dt.tags) && dt.tags.includes('bureau'))).map(dt => dt.id)
  );
  const permTypeSet = new Set(
    dayTypes.filter(dt => Array.isArray(dt.tags) && dt.tags.includes('permanence')).map(dt => dt.id)
  );

  const byMember = {};
  for (const m of members) {
    byMember[m.id] = { totalWork: 0, totalBureau: 0, totalPerm: 0, byType: {} };
    for (const dt of dayTypes) {
      byMember[m.id].byType[dt.id] = 0;
    }
  }

  const byDay = {};
  for (const dm of dateMeta) {
    byDay[dm.iso] = { _totalBureau: 0, _totalPerm: 0 };
    for (const dt of dayTypes) {
      byDay[dm.iso][dt.id] = 0;
    }
    for (const m of members) {
      const t = grid[dm.iso]?.[m.id];
      if (t) {
        byDay[dm.iso][t] = (byDay[dm.iso][t] || 0) + 1;
        if (officeTypeSet.has(t)) byDay[dm.iso]._totalBureau++;
        if (permTypeSet.has(t)) byDay[dm.iso]._totalPerm++;

        if (byMember[m.id]) {
          byMember[m.id].byType[t] = (byMember[m.id].byType[t] || 0) + 1;
          if (officeTypeSet.has(t)) byMember[m.id].totalBureau++;
          if (permTypeSet.has(t)) byMember[m.id].totalPerm++;
          const dtObj = dayTypes.find(d => d.id === t);
          if (dtObj?.isWorkingDay) {
            byMember[m.id].totalWork++;
          }
        }
      }
    }
  }

  return { byMember, byDay };
}

/**
 * Analyse toutes les alternatives possibles pour une case `(dateIso, memberId)`
 * dans la proposition courante :
 * - Indique pour chaque type de journée s'il est directement substituable sans violer de règle stricte,
 * - Ou s'il nécessite une ré-optimisation (échange avec un collègue), et quelles règles seraient impactées.
 */
export function analyzeCellAlternatives({
  grid,
  dateISOs,
  dateIso,
  memberId,
  members,
  dayTypes,
  rules,
  desiderata
}) {
  const activeMembers = members.filter(m => m.active !== false);
  const dateMeta = buildDateMetadata(dateISOs);
  const compiledRules = compileRules(rules, dayTypes, activeMembers, dateMeta);
  const dm = dateMeta.find(d => d.iso === dateIso);
  if (!dm) return [];

  const currentType = grid[dateIso]?.[memberId];
  const des = desiderata?.[`${dateIso}__${memberId}`];

  return dayTypes.map(dt => {
    const scopeCompatible =
      dt.dayScope === 'both' ||
      (dm.isWeekend && dt.dayScope === 'weekend') ||
      (!dm.isWeekend && dt.dayScope === 'weekday');

    const testGrid = cloneGrid(grid);
    if (!testGrid[dateIso]) testGrid[dateIso] = {};
    testGrid[dateIso][memberId] = dt.id;

    // Si c'est un weekend et que la règle de paire Samedi+Dimanche est active, tester aussi le remplacement sur les 2 jours du weekend
    const evaluation = evaluateSchedule(testGrid, dateMeta, activeMembers, dayTypes, desiderata, compiledRules);
    const relevantViolations = evaluation.hardViolations.filter(
      v => !v.dateIso || v.dateIso === dateIso || v.memberId === memberId
    );

    if (!scopeCompatible) {
      relevantViolations.unshift({
        severity: 'hard',
        ruleId: 'day_scope',
        ruleName: 'Compatibilité semaine / weekend',
        dateIso,
        memberId,
        message: dm.isWeekend
          ? `"${dt.label}" est réservé aux jours de semaine.`
          : `"${dt.label}" est réservé aux weekends.`
      });
    }

    const forbiddenByDesiderata = des?.forbiddenTypes?.includes(dt.id) || (des?.requiredType && des.requiredType !== dt.id);

    return {
      dayType: dt,
      isCurrent: dt.id === currentType,
      scopeCompatible,
      forbiddenByDesiderata,
      directValid: scopeCompatible && evaluation.hardViolations.length === 0,
      hardViolationsCount: evaluation.hardViolations.length + (scopeCompatible ? 0 : 1),
      relevantViolations
    };
  });
}

/**
 * Ré-optimise l'horaire autour d'un choix utilisateur sur une case précise `(dateIso, memberId) = newTypeId`,
 * en cherchant l'ajustement minimal par rapport à la grille actuelle qui respecte toutes les règles.
 */
export function reoptimizeAroundCellChange({
  currentGrid,
  dateISOs,
  dateIso,
  memberId,
  newTypeId,
  members,
  dayTypes,
  rules,
  desiderata
}) {
  const tempDesiderata = structuredClone(desiderata || {});
  const key = `${dateIso}__${memberId}`;
  tempDesiderata[key] = {
    requiredType: newTypeId,
    forbiddenTypes: []
  };

  const activeMembers = members.filter(m => m.active !== false);
  const dateMeta = buildDateMetadata(dateISOs);
  const compiledRules = compileRules(rules, dayTypes, activeMembers, dateMeta);

  // Si c'est un weekend avec règle de paire Samedi+Dimanche et que newTypeId est concerné, verrouiller aussi l'autre jour du weekend
  const dm = dateMeta.find(d => d.iso === dateIso);
  if (dm && dm.isWeekend) {
    const pairRule = compiledRules.find(
      cr => cr.kind === 'weekend_pair_consistency' && cr.severity === 'hard' && cr.targetTypeSet.has(newTypeId)
    );
    if (pairRule) {
      const otherIdx = dm.dow === 6 ? dm.idx + 1 : dm.idx - 1;
      if (otherIdx >= 0 && otherIdx < dateMeta.length && dateMeta[otherIdx].isWeekend) {
        tempDesiderata[`${dateMeta[otherIdx].iso}__${memberId}`] = {
          requiredType: newTypeId,
          forbiddenTypes: []
        };
      }
    }
  }

  // Essayer d'abord un échange simple sur le même jour (ou le même weekend) avec un autre membre
  const baseGrid = cloneGrid(currentGrid);
  const oldType = baseGrid[dateIso]?.[memberId];
  baseGrid[dateIso][memberId] = newTypeId;

  const directEval = evaluateSchedule(baseGrid, dateMeta, activeMembers, dayTypes, tempDesiderata, compiledRules);
  if (directEval.hardViolations.length === 0) {
    return {
      grid: baseGrid,
      evaluation: directEval,
      stats: computeScheduleStats(baseGrid, dateMeta, activeMembers, dayTypes),
      changedCount: 1
    };
  }

  // Tester un échange 1-pour-1 avec chaque autre membre ce jour-là (ou ce weekend-là)
  for (const other of activeMembers) {
    if (other.id === memberId) continue;
    const swapGrid = cloneGrid(currentGrid);
    const otherOldType = swapGrid[dateIso]?.[other.id];
    if (otherOldType === newTypeId && oldType) {
      swapGrid[dateIso][memberId] = newTypeId;
      swapGrid[dateIso][other.id] = oldType;

      // Si weekend pair
      if (dm && dm.isWeekend) {
        const otherIdx = dm.dow === 6 ? dm.idx + 1 : dm.idx - 1;
        if (otherIdx >= 0 && otherIdx < dateMeta.length && dateMeta[otherIdx].isWeekend) {
          const otherDateIso = dateMeta[otherIdx].iso;
          swapGrid[otherDateIso][memberId] = newTypeId;
          swapGrid[otherDateIso][other.id] = oldType;
        }
      }

      const swapEval = evaluateSchedule(swapGrid, dateMeta, activeMembers, dayTypes, tempDesiderata, compiledRules);
      if (swapEval.hardViolations.length === 0) {
        return {
          grid: swapGrid,
          evaluation: swapEval,
          stats: computeScheduleStats(swapGrid, dateMeta, activeMembers, dayTypes),
          changedCount: 2
        };
      }
    }
  }

  // Sinon, relancer le solveur avec la contrainte verrouillée
  const solved = generateSchedule({
    dateISOs,
    members,
    dayTypes,
    rules,
    desiderata: tempDesiderata,
    seed: Date.now(),
    previousGrid: null,
    maxIterations: 1500
  });

  return {
    ...solved,
    changedCount: countDifferences(currentGrid, solved.grid, dateMeta, activeMembers)
  };
}

function countDifferences(gridA, gridB, dateMeta, members) {
  let diff = 0;
  for (const dm of dateMeta) {
    for (const m of members) {
      if (gridA[dm.iso]?.[m.id] !== gridB[dm.iso]?.[m.id]) diff++;
    }
  }
  return diff;
}

