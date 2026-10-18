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
    const targetMemberSet = new Set(resolveTargetMemberIds(p.targetMembers, members));
    const matchingDayIdxs = dateMeta
      .filter(dm => matchesDayFilter(dm.dateObj, p.dayFilter))
      .map(dm => dm.idx);

    return {
      rule,
      kind: rule.kind,
      severity: rule.severity || 'hard',
      weight: Number(rule.weight) || (rule.severity === 'soft' ? 40 : 100),
      params: p,
      targetTypeSet,
      triggerTypeSet,
      targetMemberSet,
      matchingDayIdxs
    };
  });
}

/**
 * Détermine pour chaque (dateIdx, memberId) les types de journées autorisés (domaine)
 * en tenant compte de la typologie (semaine/weekend), des désidératas et des règles unaires.
 */
export function computeDomains(dateMeta, members, dayTypes, desiderata, compiledRules) {
  const defaultWeekendRest = dayTypes.find(dt => dt.isDefaultRest) || dayTypes.find(dt => dt.id === 'REPOS') || dayTypes[dayTypes.length - 1];
  const defaultWeekdayWork = dayTypes.find(dt => dt.id === 'BUREAU') || dayTypes.find(dt => dt.autoAssign && dt.dayScope !== 'weekend') || dayTypes[0];

  // Types qui peuvent être requis par une règle d'enchaînement (ex: REPOS après garde)
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
          // Chercher un type de repos ou travail non interdit
          const fallback = dayTypes.find(dt => !des.forbiddenTypes.includes(dt.id));
          allowed = [fallback ? fallback.id : (dm.isWeekend ? defaultWeekendRest.id : defaultWeekdayWork.id)];
        } else {
          allowed = [dm.isWeekend ? defaultWeekendRest.id : defaultWeekdayWork.id];
        }
      }

      domains[key] = allowed;
    }
  }

  return domains;
}

/**
 * Évalue complètement une grille d'horaires (`grid[dateIso][memberId] = typeId`)
 * par rapport à toutes les règles compilées et aux désidératas.
 */
export function evaluateSchedule(grid, dateMeta, members, dayTypes, desiderata, compiledRules) {
  const violations = []; // Liste détaillée des violations
  let hardPenalty = 0;
  let softPenalty = 0;

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
    const { rule, kind, severity, weight, params, targetTypeSet, triggerTypeSet, targetMemberSet, matchingDayIdxs } = cr;
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
            for (const dm of filteredDays) {
              const t = grid[dm.iso]?.[m.id];
              if (targetTypeSet.has(t)) count++;
            }
            if (params.min !== null && params.min !== undefined && count < params.min) {
              addViolation(
                params.min - count,
                filteredDays[0].iso,
                m.id,
                `${m.name} : ${count} j. au lieu de min. ${params.min} (${rule.name})`
              );
            }
            if (params.max !== null && params.max !== undefined && count > params.max) {
              addViolation(
                count - params.max,
                filteredDays[0].iso,
                m.id,
                `${m.name} : ${count} j. au lieu de max. ${params.max} (${rule.name})`
              );
            }
          }
        }
        break;
      }

      case 'sequence_transition': {
        const offset = Number(params.offsetDays) || 1;
        for (let dIdx = 0; dIdx < dateMeta.length; dIdx++) {
          const nextIdx = dIdx + offset;
          if (nextIdx < 0 || nextIdx >= dateMeta.length) continue;
          const dmNow = dateMeta[dIdx];
          const dmNext = dateMeta[nextIdx];

          for (const m of members) {
            if (!targetMemberSet.has(m.id)) continue;
            const tNow = grid[dmNow.iso]?.[m.id];
            if (!triggerTypeSet.has(tNow)) continue;

            // Si c'est un samedi et que le dimanche est aussi un jour de garde, la transition s'applique surtout du dimanche au lundi
            if (dmNow.dow === 6 && offset === 1 && dmNext.dow === 0 && triggerTypeSet.has(grid[dmNext.iso]?.[m.id])) {
              continue;
            }

            const tNext = grid[dmNext.iso]?.[m.id];
            if (params.mode === 'forbid' && targetTypeSet.has(tNext)) {
              addViolation(
                1.5,
                dmNext.iso,
                m.id,
                `${m.name} (${formatDateShort(dmNext.iso)}) : "${tNext}" interdit après "${tNow}" (${rule.name})`
              );
            } else if (params.mode === 'require' && !targetTypeSet.has(tNext)) {
              addViolation(
                1.5,
                dmNext.iso,
                m.id,
                `${m.name} (${formatDateShort(dmNext.iso)}) : doit être en [${Array.from(targetTypeSet).join('/')}] après "${tNow}" (${rule.name})`
              );
            }
          }
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
                  `${m.name} (${formatDateShort(dmSat.iso)}-${formatDateShort(dmSun.iso)}) : garde weekend coupée (${rule.name})`
                );
              }
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
          // Calculer l'écart pour chaque type ciblé ET pour la somme des types ciblés
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
            if (spread > 1) {
              softPenalty += (spread - 1) * (weight * 0.35);
            }
          }
          // Aussi équilibrer le total combiné des types ciblés
          const totalCounts = targetMembersArr.map(m => {
            let c = 0;
            for (const dm of dateMeta) {
              if (targetTypeSet.has(grid[dm.iso]?.[m.id])) c++;
            }
            return c;
          });
          const spreadTotal = Math.max(...totalCounts) - Math.min(...totalCounts);
          if (spreadTotal > 1) {
            softPenalty += (spreadTotal - 1) * (weight * 0.5);
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

  // 2. Planifier les weekends en premier (pour respecter weekend_pair_consistency et préparer les lundis)
  const hasWeekendPairRule = compiledRules.some(cr => cr.kind === 'weekend_pair_consistency' && cr.severity === 'hard');
  const weekendDutyRule = compiledRules.find(
    cr => cr.kind === 'daily_headcount' && (cr.params.dayFilter === 'weekend' || cr.params.dayFilter === 'all') && cr.params.min > 0
  );
  const dutyTypeId = weekendDutyRule ? Array.from(weekendDutyRule.targetTypeSet)[0] : 'GARDE_WE';
  const dutyTargetCount = weekendDutyRule ? (weekendDutyRule.params.min || 1) : 0;

  for (let dIdx = 0; dIdx < dateMeta.length; dIdx++) {
    const dm = dateMeta[dIdx];
    if (!dm.isWeekend) continue;

    // Si Samedi + Dimanche consécutifs et règle de paire active
    if (dm.dow === 6 && dIdx + 1 < dateMeta.length && dateMeta[dIdx + 1].dow === 0 && hasWeekendPairRule) {
      const dmSat = dm;
      const dmSun = dateMeta[dIdx + 1];

      // Combien de personnes ont déjà la garde imposée par désidérata ?
      const preAssigned = members.filter(
        m => grid[dmSat.iso][m.id] === dutyTypeId || grid[dmSun.iso][m.id] === dutyTypeId
      );
      for (const m of preAssigned) {
        if (!grid[dmSat.iso][m.id] && domains[`${dmSat.iso}__${m.id}`].includes(dutyTypeId)) {
          grid[dmSat.iso][m.id] = dutyTypeId;
        }
        if (!grid[dmSun.iso][m.id] && domains[`${dmSun.iso}__${m.id}`].includes(dutyTypeId)) {
          grid[dmSun.iso][m.id] = dutyTypeId;
        }
      }

      let currentDutyCount = members.filter(m => grid[dmSat.iso][m.id] === dutyTypeId).length;
      // Trier les candidats éligibles les deux jours et ayant le moins de gardes jusqu'ici
      const candidates = shuffleWithRNG(members, rng)
        .filter(m =>
          !grid[dmSat.iso][m.id] &&
          !grid[dmSun.iso][m.id] &&
          domains[`${dmSat.iso}__${m.id}`].includes(dutyTypeId) &&
          domains[`${dmSun.iso}__${m.id}`].includes(dutyTypeId)
        )
        .sort((a, b) => (memberTypeCounts[a.id][dutyTypeId] || 0) - (memberTypeCounts[b.id][dutyTypeId] || 0));

      for (const cand of candidates) {
        if (currentDutyCount >= dutyTargetCount) break;
        grid[dmSat.iso][cand.id] = dutyTypeId;
        grid[dmSun.iso][cand.id] = dutyTypeId;
        memberTypeCounts[cand.id][dutyTypeId] = (memberTypeCounts[cand.id][dutyTypeId] || 0) + 2;
        currentDutyCount++;
      }

      // Les autres sont en repos weekend
      for (const m of members) {
        for (const dayW of [dmSat, dmSun]) {
          if (!grid[dayW.iso][m.id]) {
            const dom = domains[`${dayW.iso}__${m.id}`];
            const chosen = dom.includes(defaultWeekendRest) ? defaultWeekendRest : dom[0];
            grid[dayW.iso][m.id] = chosen;
          }
        }
      }
      dIdx++; // Sauter dimanche car déjà traité
    } else {
      // Jour de weekend isolé ou sans règle de paire
      let currentDutyCount = members.filter(m => grid[dm.iso][m.id] === dutyTypeId).length;
      const candidates = shuffleWithRNG(members, rng)
        .filter(m => !grid[dm.iso][m.id] && domains[`${dm.iso}__${m.id}`].includes(dutyTypeId))
        .sort((a, b) => (memberTypeCounts[a.id][dutyTypeId] || 0) - (memberTypeCounts[b.id][dutyTypeId] || 0));

      for (const cand of candidates) {
        if (currentDutyCount >= dutyTargetCount) break;
        grid[dm.iso][cand.id] = dutyTypeId;
        memberTypeCounts[cand.id][dutyTypeId] = (memberTypeCounts[cand.id][dutyTypeId] || 0) + 1;
        currentDutyCount++;
      }
      for (const m of members) {
        if (!grid[dm.iso][m.id]) {
          const dom = domains[`${dm.iso}__${m.id}`];
          grid[dm.iso][m.id] = dom.includes(defaultWeekendRest) ? defaultWeekendRest : dom[0];
        }
      }
    }
  }

  // 3. Planifier les jours de semaine semaine par semaine
  const weeksMap = new Map();
  for (const dm of dateMeta) {
    if (!weeksMap.has(dm.weekIndex)) weeksMap.set(dm.weekIndex, []);
    weeksMap.get(dm.weekIndex).push(dm);
  }

  // Règles d'enchaînement (ex: pas de TT après GARDE_WE)
  const transitionRules = compiledRules.filter(cr => cr.kind === 'sequence_transition');
  // Quotas hebdomadaires (ex: max 2 TT par semaine)
  const weeklyQuotaRules = compiledRules.filter(cr => cr.kind === 'member_period_count' && cr.params.period === 'week');

  for (const weekDays of weeksMap.values()) {
    const weekdays = weekDays.filter(d => !d.isWeekend);

    for (const dm of weekdays) {
      // Vérifier pour chaque membre quels types sont interdits par transition depuis J-offset
      const allowedTodayForMember = {};
      for (const m of members) {
        let dom = [...domains[`${dm.iso}__${m.id}`]];
        for (const tr of transitionRules) {
          if (!tr.targetMemberSet.has(m.id)) continue;
          const prevIdx = dm.idx - (Number(tr.params.offsetDays) || 1);
          if (prevIdx >= 0 && prevIdx < dateMeta.length) {
            const prevType = grid[dateMeta[prevIdx].iso]?.[m.id];
            if (tr.triggerTypeSet.has(prevType)) {
              if (tr.params.mode === 'forbid') {
                const filtered = dom.filter(t => !tr.targetTypeSet.has(t));
                if (filtered.length > 0) dom = filtered;
              } else if (tr.params.mode === 'require') {
                const filtered = dom.filter(t => tr.targetTypeSet.has(t));
                if (filtered.length > 0) dom = filtered;
              }
            }
          }
        }

        // Vérifier les quotas max hebdomadaires déjà atteints dans la semaine
        for (const wq of weeklyQuotaRules) {
          if (wq.params.max !== null && wq.params.max !== undefined && wq.targetMemberSet.has(m.id)) {
            let countInWeek = 0;
            for (const wd of weekDays) {
              const assignedT = grid[wd.iso]?.[m.id];
              if (assignedT && wq.targetTypeSet.has(assignedT)) countInWeek++;
            }
            if (countInWeek >= wq.params.max) {
              const filtered = dom.filter(t => !wq.targetTypeSet.has(t));
              if (filtered.length > 0) dom = filtered;
            }
          }
        }

        allowedTodayForMember[m.id] = dom;
      }

      // Attribuer d'abord les quotas journaliers spécifiques (ex: exactement 1 TT_PERM)
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
          .filter(m => !grid[dm.iso][m.id] && allowedTodayForMember[m.id].includes(targetType))
          .sort((a, b) => (memberTypeCounts[a.id][targetType] || 0) - (memberTypeCounts[b.id][targetType] || 0));

        for (const cand of candidates) {
          if (current >= needed) break;
          grid[dm.iso][cand.id] = targetType;
          memberTypeCounts[cand.id][targetType] = (memberTypeCounts[cand.id][targetType] || 0) + 1;
          current++;
        }
      }

      // Attribuer ensuite du télétravail (TT) tout en gardant le minimum requis au BUREAU
      const minBureauRule = compiledRules.find(
        cr => cr.kind === 'daily_headcount' &&
          cr.matchingDayIdxs.includes(dm.idx) &&
          cr.targetTypeSet.has(defaultWeekdayWork) &&
          cr.params.min > 0
      );
      const minBureau = minBureauRule ? minBureauRule.params.min : 0;

      // Membres restants à affecter aujourd'hui
      const unassigned = shuffleWithRNG(members, rng).filter(m => !grid[dm.iso][m.id]);

      // Trier les membres restants : ceux qui ont eu le MOINS de télétravail jusqu'ici sont prioritaires pour TT
      const ttTypes = dayTypes.filter(dt => dt.id !== defaultWeekdayWork && dt.autoAssign && dt.dayScope !== 'weekend' && !exactDailyRules.some(r => r.targetTypeSet.has(dt.id))).map(dt => dt.id);

      unassigned.sort((a, b) => {
        const ttA = ttTypes.reduce((acc, t) => acc + (memberTypeCounts[a.id][t] || 0), 0);
        const ttB = ttTypes.reduce((acc, t) => acc + (memberTypeCounts[b.id][t] || 0), 0);
        return ttA - ttB;
      });

      for (let i = 0; i < unassigned.length; i++) {
        const m = unassigned[i];
        const dom = allowedTodayForMember[m.id];
        const currentBureauCount = members.filter(x => grid[dm.iso][x.id] === defaultWeekdayWork).length;
        const remainingCouldBeBureau = unassigned.slice(i + 1).filter(x => allowedTodayForMember[x.id].includes(defaultWeekdayWork)).length;

        // Si on doit impérativement mettre ce membre au bureau pour atteindre minBureau
        if (
          dom.includes(defaultWeekdayWork) &&
          currentBureauCount + remainingCouldBeBureau < minBureau
        ) {
          grid[dm.iso][m.id] = defaultWeekdayWork;
          memberTypeCounts[m.id][defaultWeekdayWork] = (memberTypeCounts[m.id][defaultWeekdayWork] || 0) + 1;
          continue;
        }

        // Sinon, regarder si un type TT est disponible et pertinent
        const availTT = dom.filter(t => ttTypes.includes(t));
        if (availTT.length > 0 && currentBureauCount + remainingCouldBeBureau >= minBureau) {
          const chosenTT = availTT[Math.floor(rng() * availTT.length)];
          grid[dm.iso][m.id] = chosenTT;
          memberTypeCounts[m.id][chosenTT] = (memberTypeCounts[m.id][chosenTT] || 0) + 1;
        } else if (dom.includes(defaultWeekdayWork)) {
          grid[dm.iso][m.id] = defaultWeekdayWork;
          memberTypeCounts[m.id][defaultWeekdayWork] = (memberTypeCounts[m.id][defaultWeekdayWork] || 0) + 1;
        } else {
          const fallback = dom[Math.floor(rng() * dom.length)];
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
 * pour que le bouton "Autre proposition" propose un horaire réellement différent.
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
  // Pénalité légère si trop similaire (> 80% identique)
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
  maxIterations = 1800
}) {
  const activeMembers = members.filter(m => m.active !== false);
  const dateMeta = buildDateMetadata(dateISOs);
  const compiledRules = compileRules(rules, dayTypes, activeMembers, dateMeta);
  const domains = computeDomains(dateMeta, activeMembers, dayTypes, desiderata, compiledRules);

  const hasWeekendPairRule = compiledRules.some(cr => cr.kind === 'weekend_pair_consistency' && cr.severity === 'hard');

  let globalBestGrid = null;
  let globalBestEval = null;
  let globalBestObjective = Infinity;

  // Multi-start (3 démarrages constructifs différents) pour maximiser les chances de 0 violation
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

    // Recherche locale (mutations unitaires, échanges entre 2 membres le même jour, échanges de weekend)
    for (let iter = 0; iter < iterPerStart; iter++) {
      const temperature = Math.max(0.5, (1 - iter / iterPerStart) * 15);
      const moveRoll = rng();

      // Choisir un jour au hasard (ou cibler un jour avec violation 50% du temps)
      let targetDateIso;
      if (currentEval.hardViolations.length > 0 && rng() < 0.6) {
        const v = currentEval.hardViolations[Math.floor(rng() * currentEval.hardViolations.length)];
        targetDateIso = v.dateIso || dateMeta[Math.floor(rng() * dateMeta.length)].iso;
      } else {
        targetDateIso = dateMeta[Math.floor(rng() * dateMeta.length)].iso;
      }

      const dm = dateMeta.find(d => d.iso === targetDateIso) || dateMeta[0];

      // Mouvement 1 : Échange de garde sur tout un weekend (Samedi + Dimanche) entre 2 membres
      if (dm.isWeekend && hasWeekendPairRule && activeMembers.length >= 2) {
        const satIdx = dm.dow === 6 ? dm.idx : dm.idx - 1;
        const sunIdx = satIdx + 1;
        if (satIdx >= 0 && sunIdx < dateMeta.length && dateMeta[satIdx].dow === 6 && dateMeta[sunIdx].dow === 0) {
          const satIso = dateMeta[satIdx].iso;
          const sunIso = dateMeta[sunIdx].iso;
          const m1 = activeMembers[Math.floor(rng() * activeMembers.length)];
          const m2 = activeMembers[Math.floor(rng() * activeMembers.length)];
          if (m1.id !== m2.id) {
            const t1Sat = currentGrid[satIso][m1.id];
            const t2Sat = currentGrid[satIso][m2.id];
            const t1Sun = currentGrid[sunIso][m1.id];
            const t2Sun = currentGrid[sunIso][m2.id];

            if (
              t1Sat !== t2Sat &&
              domains[`${satIso}__${m1.id}`].includes(t2Sat) &&
              domains[`${satIso}__${m2.id}`].includes(t1Sat) &&
              domains[`${sunIso}__${m1.id}`].includes(t2Sun) &&
              domains[`${sunIso}__${m2.id}`].includes(t1Sun)
            ) {
              currentGrid[satIso][m1.id] = t2Sat;
              currentGrid[satIso][m2.id] = t1Sat;
              currentGrid[sunIso][m1.id] = t2Sun;
              currentGrid[sunIso][m2.id] = t1Sun;

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
                // Annuler
                currentGrid[satIso][m1.id] = t1Sat;
                currentGrid[satIso][m2.id] = t2Sat;
                currentGrid[sunIso][m1.id] = t1Sun;
                currentGrid[sunIso][m2.id] = t2Sun;
              }
            }
          }
          continue;
        }
      }

      // Mouvement 2 (50% du temps) : Échanger les rôles de 2 membres le même jour (préserve les quotas journaliers !)
      if (moveRoll < 0.5 && activeMembers.length >= 2) {
        const m1 = activeMembers[Math.floor(rng() * activeMembers.length)];
        const m2 = activeMembers[Math.floor(rng() * activeMembers.length)];
        if (m1.id === m2.id) continue;

        const t1 = currentGrid[dm.iso][m1.id];
        const t2 = currentGrid[dm.iso][m2.id];
        if (t1 === t2) continue;

        const dom1 = domains[`${dm.iso}__${m1.id}`];
        const dom2 = domains[`${dm.iso}__${m2.id}`];

        if (dom1.includes(t2) && dom2.includes(t1)) {
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
      } else {
        // Mouvement 3 : Changer le type de journée d'un membre sur ce jour parmi son domaine
        const m = activeMembers[Math.floor(rng() * activeMembers.length)];
        const dom = domains[`${dm.iso}__${m.id}`];
        if (dom.length <= 1) continue;

        const oldType = currentGrid[dm.iso][m.id];
        const candidates = dom.filter(t => t !== oldType);
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
  const byMember = {};
  for (const m of members) {
    byMember[m.id] = { totalWork: 0, byType: {} };
    for (const dt of dayTypes) {
      byMember[m.id].byType[dt.id] = 0;
    }
  }

  const byDay = {};
  for (const dm of dateMeta) {
    byDay[dm.iso] = {};
    for (const dt of dayTypes) {
      byDay[dm.iso][dt.id] = 0;
    }
    for (const m of members) {
      const t = grid[dm.iso]?.[m.id];
      if (t) {
        byDay[dm.iso][t] = (byDay[dm.iso][t] || 0) + 1;
        if (byMember[m.id]) {
          byMember[m.id].byType[t] = (byMember[m.id].byType[t] || 0) + 1;
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

