/**
 * Schéma générique des règles d'organisation, validation, normalisation (robuste aux sorties LLM)
 * et générateur de prompt pour LLM externe.
 */

export const RULE_KINDS = {
  daily_headcount: {
    label: 'Effectif quotidien (Quotas par jour)',
    description: 'Impose un nombre minimum, maximum ou exact de personnes affectées à certains types de journées chaque jour.',
    defaultParams: {
      dayFilter: 'weekday',
      targetTypes: ['BUREAU'],
      min: 3,
      max: null
    }
  },
  member_period_count: {
    label: 'Quota par personne sur une période',
    description: 'Limite ou impose un nombre de jours d\'un certain type par personne sur chaque semaine ou sur toute la période.',
    defaultParams: {
      period: 'week',
      dayFilter: 'all',
      targetTypes: ['TT', 'TT_PERM'],
      targetMembers: 'all',
      min: 0,
      max: 2
    }
  },
  sequence_transition: {
    label: 'Enchaînement / Succession de jours',
    description: 'Interdit ou impose certains types de journées le(s) jour(s) suivant un type de journée donné (ex: après une garde weekend).',
    defaultParams: {
      triggerTypes: ['GARDE_WE'],
      offsetDays: 1,
      mode: 'forbid',
      targetTypes: ['TT', 'TT_PERM'],
      targetMembers: 'all'
    }
  },
  max_consecutive_days: {
    label: 'Nombre maximum de jours consécutifs',
    description: 'Empêche un membre d\'enchaîner plus de N jours consécutifs d\'un type donné.',
    defaultParams: {
      targetTypes: ['TT', 'TT_PERM'],
      maxConsecutive: 2,
      skipWeekends: false,
      targetMembers: 'all'
    }
  },
  weekend_pair_consistency: {
    label: 'Continuité sur le weekend (Samedi + Dimanche)',
    description: 'Impose que la même personne assure à la fois le samedi et le dimanche pour les types sélectionnés (ex: Garde weekend).',
    defaultParams: {
      targetTypes: ['GARDE_WE']
    }
  },
  member_day_restriction: {
    label: 'Règle récurrente par jour de la semaine',
    description: 'Interdit ou impose un type de journée certains jours de la semaine (ex: pas de télétravail le lundi, ou temps partiel le mercredi).',
    defaultParams: {
      daysOfWeek: [3], // 1=Lun, 2=Mar, 3=Mer, 4=Jeu, 5=Ven, 6=Sam, 0=Dim
      mode: 'forbid',
      targetTypes: ['TT', 'TT_PERM'],
      targetMembers: 'all'
    }
  },
  member_compatibility: {
    label: 'Compatibilité / Binômage entre membres',
    description: 'Empêche ou impose que certains membres soient simultanément sur le même type de journée (ex: pas en télétravail en même temps).',
    defaultParams: {
      dayFilter: 'weekday',
      mode: 'not_together', // 'not_together' | 'together' | 'at_least_one'
      targetTypes: ['TT', 'TT_PERM'],
      targetMembers: []
    }
  },
  fairness_balance: {
    label: 'Équité de répartition entre les membres',
    description: 'Équilibre équitablement le nombre d\'attributions de certains types de journées entre tous les membres sur la période.',
    defaultParams: {
      targetTypes: ['TT', 'TT_PERM', 'GARDE_WE'],
      targetMembers: 'all'
    }
  }
};

export const DAY_NAMES_FR = {
  1: 'Lundi',
  2: 'Mardi',
  3: 'Mercredi',
  4: 'Jeudi',
  5: 'Vendredi',
  6: 'Samedi',
  0: 'Dimanche',
  7: 'Dimanche'
};

/**
 * Résout une liste de cibles (IDs de types ou tags "tag:xxx") vers un Set d'IDs de types de journées.
 */
export function resolveTargetTypeIds(targetSpec, dayTypes) {
  if (!targetSpec) return [];
  const rawList = Array.isArray(targetSpec) ? targetSpec : [targetSpec];
  const resolved = new Set();

  for (const item of rawList) {
    if (!item || typeof item !== 'string') continue;
    const trimmed = item.trim();
    const upper = trimmed.toUpperCase();
    const lower = trimmed.toLowerCase();

    // Correspondance directe par ID ou label court
    const directMatch = dayTypes.find(
      dt => dt.id.toUpperCase() === upper || dt.shortLabel.toLowerCase() === lower || dt.label.toLowerCase() === lower
    );
    if (directMatch) {
      resolved.add(directMatch.id);
      continue;
    }

    // Correspondance par tag explicite "tag:teletravail" ou implicite "teletravail"
    const tagSearch = lower.startsWith('tag:') ? lower.slice(4).trim() : lower;
    for (const dt of dayTypes) {
      if (Array.isArray(dt.tags) && dt.tags.some(t => t.toLowerCase() === tagSearch)) {
        resolved.add(dt.id);
      }
    }
  }

  return Array.from(resolved);
}

/**
 * Résout une spécification de membres ('all' ou tableau d'IDs/noms) vers une liste d'IDs de membres.
 */
export function resolveTargetMemberIds(memberSpec, members) {
  const activeMembers = members.filter(m => m.active !== false);
  if (!memberSpec || memberSpec === 'all' || memberSpec === '*' || (Array.isArray(memberSpec) && memberSpec.length === 0)) {
    return activeMembers.map(m => m.id);
  }
  const rawList = Array.isArray(memberSpec) ? memberSpec : [memberSpec];
  const resolved = new Set();
  for (const item of rawList) {
    if (!item || typeof item !== 'string') continue;
    const lower = item.trim().toLowerCase();
    if (lower === 'all' || lower === '*' || lower === 'tous') {
      return activeMembers.map(m => m.id);
    }
    const found = activeMembers.find(
      m => m.id.toLowerCase() === lower || m.name.toLowerCase() === lower || m.role?.toLowerCase() === lower
    );
    if (found) resolved.add(found.id);
  }
  return Array.from(resolved);
}

/**
 * Vérifie si une date correspond à un filtre de jour ('weekday', 'weekend', 'all', ou tableau de jours 0-6).
 */
export function matchesDayFilter(dateObj, dayFilter) {
  const dow = dateObj.getDay(); // 0 = Dim, 1..5 = Lun..Ven, 6 = Sam
  const isWeekend = dow === 0 || dow === 6;
  if (!dayFilter || dayFilter === 'all' || dayFilter === '*') return true;
  if (dayFilter === 'weekday' || dayFilter === 'weekdays' || dayFilter === 'semaine') return !isWeekend;
  if (dayFilter === 'weekend' || dayFilter === 'weekends') return isWeekend;
  if (Array.isArray(dayFilter)) {
    return dayFilter.some(d => {
      if (typeof d === 'number') return (d === 7 ? 0 : d) === dow;
      const s = String(d).toLowerCase().slice(0, 3);
      const map = { dim: 0, sun: 0, lun: 1, mon: 1, mar: 2, tue: 2, mer: 3, wed: 3, jeu: 4, thu: 4, ven: 5, fri: 5, sam: 6, sat: 6 };
      return map[s] === dow;
    });
  }
  return true;
}

/**
 * Normalise une règle potentiellement générée par un LLM externe afin de tolérer
 * différentes variantes de syntaxe JSON (ex: synonymes de kind, paramètres à plat ou dans params).
 */
export function normalizeRule(rawRule, index = 0) {
  if (!rawRule || typeof rawRule !== 'object') {
    throw new Error(`La règle #${index + 1} n'est pas un objet JSON valide.`);
  }

  // Détection souple du type de règle (kind / type / ruleType)
  let rawKind = String(rawRule.kind || rawRule.type || rawRule.ruleType || '').trim().toLowerCase();
  const kindAliases = {
    daily_quota: 'daily_headcount',
    daily_count: 'daily_headcount',
    daily_min_max: 'daily_headcount',
    headcount: 'daily_headcount',
    quota_jour: 'daily_headcount',
    member_quota: 'member_period_count',
    weekly_quota: 'member_period_count',
    period_count: 'member_period_count',
    quota_membre: 'member_period_count',
    transition: 'sequence_transition',
    sequence: 'sequence_transition',
    after_duty: 'sequence_transition',
    enchainement: 'sequence_transition',
    consecutive: 'max_consecutive_days',
    max_consecutive: 'max_consecutive_days',
    jours_consecutifs: 'max_consecutive_days',
    weekend_pair: 'weekend_pair_consistency',
    weekend_consistency: 'weekend_pair_consistency',
    same_weekend: 'weekend_pair_consistency',
    day_restriction: 'member_day_restriction',
    recurring_day: 'member_day_restriction',
    jour_semaine: 'member_day_restriction',
    compatibility: 'member_compatibility',
    incompatibility: 'member_compatibility',
    pair_members: 'member_compatibility',
    fairness: 'fairness_balance',
    balance: 'fairness_balance',
    equite: 'fairness_balance'
  };
  const kind = kindAliases[rawKind] || rawKind;

  if (!RULE_KINDS[kind]) {
    throw new Error(
      `Type de règle inconnu "${rawKind}" pour la règle "${rawRule.name || '#' + (index + 1)}". ` +
      `Types supportés : ${Object.keys(RULE_KINDS).join(', ')}.`
    );
  }

  // Fusionner les paramètres qu'ils soient dans `params` ou à la racine de l'objet
  const p = { ...RULE_KINDS[kind].defaultParams, ...rawRule, ...(rawRule.params || {}) };

  const id = rawRule.id || `r_custom_${Date.now()}_${index}`;
  const name = rawRule.name || rawRule.label || rawRule.title || RULE_KINDS[kind].label;
  const description = rawRule.description || rawRule.desc || '';
  const enabled = rawRule.enabled !== undefined ? Boolean(rawRule.enabled) : true;
  const severity = (rawRule.severity === 'soft' || rawRule.hard === false) ? 'soft' : 'hard';
  const weight = Number.isFinite(Number(rawRule.weight)) ? Number(rawRule.weight) : (severity === 'hard' ? 100 : 50);

  const params = {};
  const targetTypesRaw = p.targetTypes || p.types || p.dayTypes || p.dayType || p.forbidTypes || p.requireTypes;

  switch (kind) {
    case 'daily_headcount': {
      params.dayFilter = p.dayFilter || p.days || 'weekday';
      params.targetTypes = Array.isArray(targetTypesRaw) ? targetTypesRaw : (targetTypesRaw ? [targetTypesRaw] : ['BUREAU']);
      if (p.exact !== undefined && p.exact !== null && p.exact !== '') {
        params.min = Number(p.exact);
        params.max = Number(p.exact);
      } else {
        params.min = (p.min !== undefined && p.min !== null && p.min !== '') ? Number(p.min) : null;
        params.max = (p.max !== undefined && p.max !== null && p.max !== '') ? Number(p.max) : null;
      }
      break;
    }
    case 'member_period_count': {
      params.period = p.period === 'horizon' || p.period === 'total' ? 'horizon' : 'week';
      params.dayFilter = p.dayFilter || 'all';
      params.targetTypes = Array.isArray(targetTypesRaw) ? targetTypesRaw : (targetTypesRaw ? [targetTypesRaw] : ['TT']);
      params.targetMembers = p.targetMembers || p.members || 'all';
      if (p.exact !== undefined && p.exact !== null && p.exact !== '') {
        params.min = Number(p.exact);
        params.max = Number(p.exact);
      } else {
        params.min = (p.min !== undefined && p.min !== null && p.min !== '') ? Number(p.min) : null;
        params.max = (p.max !== undefined && p.max !== null && p.max !== '') ? Number(p.max) : null;
      }
      break;
    }
    case 'sequence_transition': {
      const trig = p.triggerTypes || p.fromTypes || p.afterTypes || p.trigger || ['GARDE_WE'];
      params.triggerTypes = Array.isArray(trig) ? trig : [trig];
      params.offsetDays = Number.isFinite(Number(p.offsetDays)) ? Number(p.offsetDays) : 1;
      params.mode = (p.mode === 'require' || p.mode === 'must') ? 'require' : 'forbid';
      const targ = p.targetTypes || p.forbidTypes || p.requireTypes || p.toTypes || ['TT', 'TT_PERM'];
      params.targetTypes = Array.isArray(targ) ? targ : [targ];
      params.targetMembers = p.targetMembers || p.members || 'all';
      break;
    }
    case 'max_consecutive_days': {
      params.targetTypes = Array.isArray(targetTypesRaw) ? targetTypesRaw : (targetTypesRaw ? [targetTypesRaw] : ['TT']);
      params.maxConsecutive = Number.isFinite(Number(p.maxConsecutive || p.max)) ? Number(p.maxConsecutive || p.max) : 2;
      params.skipWeekends = Boolean(p.skipWeekends);
      params.targetMembers = p.targetMembers || p.members || 'all';
      break;
    }
    case 'weekend_pair_consistency': {
      params.targetTypes = Array.isArray(targetTypesRaw) ? targetTypesRaw : (targetTypesRaw ? [targetTypesRaw] : ['GARDE_WE']);
      break;
    }
    case 'member_day_restriction': {
      const dows = p.daysOfWeek || p.days || [3];
      params.daysOfWeek = (Array.isArray(dows) ? dows : [dows]).map(Number);
      params.mode = (p.mode === 'require' || p.mode === 'must') ? 'require' : 'forbid';
      params.targetTypes = Array.isArray(targetTypesRaw) ? targetTypesRaw : (targetTypesRaw ? [targetTypesRaw] : ['TT']);
      params.targetMembers = p.targetMembers || p.members || 'all';
      break;
    }
    case 'member_compatibility': {
      params.dayFilter = p.dayFilter || 'weekday';
      params.mode = ['not_together', 'together', 'at_least_one'].includes(p.mode) ? p.mode : 'not_together';
      params.targetTypes = Array.isArray(targetTypesRaw) ? targetTypesRaw : (targetTypesRaw ? [targetTypesRaw] : ['TT']);
      params.targetMembers = Array.isArray(p.targetMembers || p.members) ? (p.targetMembers || p.members) : [];
      break;
    }
    case 'fairness_balance': {
      params.targetTypes = Array.isArray(targetTypesRaw) ? targetTypesRaw : (targetTypesRaw ? [targetTypesRaw] : ['TT', 'GARDE_WE']);
      params.targetMembers = p.targetMembers || p.members || 'all';
      break;
    }
  }

  return {
    id,
    name,
    description,
    enabled,
    severity,
    weight,
    kind,
    params
  };
}

/**
 * Parse et valide un JSON de règles (tableau de règles ou objet `{ rules: [...] }`).
 */
export function parseRulesFromJSON(jsonInput) {
  let parsed;
  if (typeof jsonInput === 'string') {
    // Nettoyer d'éventuels blocs markdown ```json ... ``` copiés d'un LLM
    const cleaned = jsonInput.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    parsed = JSON.parse(cleaned);
  } else {
    parsed = jsonInput;
  }

  const rawArray = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.rules) ? parsed.rules : [parsed]);

  return rawArray.map((r, idx) => normalizeRule(r, idx));
}

/**
 * Résumé lisible par l'humain des paramètres d'une règle.
 */
export function summarizeRuleParams(rule, dayTypes, members) {
  const p = rule.params || {};
  const formatTypes = (types) => {
    if (!types || types.length === 0) return 'Aucun type';
    return types.map(t => {
      const found = dayTypes.find(dt => dt.id === t);
      return found ? found.shortLabel : t;
    }).join(' + ');
  };
  const formatMembers = (mSpec) => {
    if (!mSpec || mSpec === 'all' || (Array.isArray(mSpec) && mSpec.length === 0)) return 'Tous les membres';
    const arr = Array.isArray(mSpec) ? mSpec : [mSpec];
    return arr.map(idOrName => {
      const m = members.find(x => x.id === idOrName || x.name === idOrName);
      return m ? m.name : idOrName;
    }).join(', ');
  };
  const filterLabel = p.dayFilter === 'weekday' ? 'Lun–Ven' : p.dayFilter === 'weekend' ? 'Sam–Dim' : 'Tous les jours';

  switch (rule.kind) {
    case 'daily_headcount': {
      const bounds = [];
      if (p.min !== null && p.min !== undefined && p.min === p.max) {
        bounds.push(`exactement ${p.min}`);
      } else {
        if (p.min !== null && p.min !== undefined) bounds.push(`min. ${p.min}`);
        if (p.max !== null && p.max !== undefined) bounds.push(`max. ${p.max}`);
      }
      return `${filterLabel} : ${bounds.join(', ')} pers. en [${formatTypes(p.targetTypes)}]`;
    }
    case 'member_period_count': {
      const periodStr = p.period === 'horizon' ? 'sur la période' : 'par semaine';
      const bounds = [];
      if (p.min !== null && p.min !== undefined && p.min > 0) bounds.push(`min. ${p.min}`);
      if (p.max !== null && p.max !== undefined) bounds.push(`max. ${p.max}`);
      return `${formatMembers(p.targetMembers)} : ${bounds.join(', ')} j. de [${formatTypes(p.targetTypes)}] ${periodStr}`;
    }
    case 'sequence_transition': {
      const act = p.mode === 'require' ? 'impose' : 'interdit';
      return `J+${p.offsetDays || 1} après [${formatTypes(p.triggerTypes)}] ➔ ${act} [${formatTypes(p.targetTypes)}] (${formatMembers(p.targetMembers)})`;
    }
    case 'max_consecutive_days':
      return `Max. ${p.maxConsecutive} jours consécutifs de [${formatTypes(p.targetTypes)}] (${formatMembers(p.targetMembers)})`;
    case 'weekend_pair_consistency':
      return `Même personne Samedi & Dimanche pour [${formatTypes(p.targetTypes)}]`;
    case 'member_day_restriction': {
      const days = (p.daysOfWeek || []).map(d => DAY_NAMES_FR[d] || d).join(', ');
      const act = p.mode === 'require' ? 'impose' : 'interdit';
      return `${days} : ${act} [${formatTypes(p.targetTypes)}] pour ${formatMembers(p.targetMembers)}`;
    }
    case 'member_compatibility': {
      const modeStr = p.mode === 'together' ? 'ensemble' : p.mode === 'at_least_one' ? 'au moins 1 présent' : 'pas en même temps';
      return `${formatMembers(p.targetMembers)} : ${modeStr} sur [${formatTypes(p.targetTypes)}] (${filterLabel})`;
    }
    case 'fairness_balance':
      return `Équilibrer équitablement [${formatTypes(p.targetTypes)}] entre ${formatMembers(p.targetMembers)}`;
    default:
      return rule.description || rule.name;
  }
}

/**
 * Génère un prompt complet et structuré à copier-coller dans un LLM (ChatGPT, Claude, Mistral, Gemini)
 * pour traduire les règles en langage naturel d'une organisation vers le format JSON de l'application.
 */
export function generateLLMPrompt(dayTypes, members, currentRules = []) {
  const typesDoc = dayTypes.map(dt =>
    `- "${dt.id}" (${dt.label}, scope: ${dt.dayScope}, tags: [${(dt.tags || []).join(', ')}])`
  ).join('\n');

  const membersDoc = members.map(m => `- "${m.name}" (id: "${m.id}")`).join('\n');

  return `Tu es un assistant expert en planification d'horaires d'équipe.
Convertis les règles d'organisation que je vais te décrire en un tableau JSON strict compatible avec l'application "ici.be/timetable".

### 1. Typologie des journées configurées dans l'application :
${typesDoc}

### 2. Membres de l'équipe :
${membersDoc}

### 3. Schéma des règles supportées (propriété "kind") :
Chaque règle est un objet JSON de la forme :
{
  "id": "identifiant_unique",
  "name": "Titre court de la règle",
  "description": "Explication claire",
  "enabled": true,
  "severity": "hard", // "hard" (stricte/obligatoire) ou "soft" (souhaitable/optimisation)
  "weight": 100, // 10 à 100
  "kind": "<UN_DES_TYPES_CI_DESSOUS>",
  "params": { ... }
}

Types "kind" disponibles et leurs "params" :
1. "daily_headcount" (Quotas par jour) :
   params: { "dayFilter": "weekday" | "weekend" | "all" | [1,2,3,4,5], "targetTypes": ["BUREAU"], "min": 3, "max": null }
2. "member_period_count" (Quota par personne par semaine ou sur toute la période) :
   params: { "period": "week" | "horizon", "dayFilter": "all", "targetTypes": ["TT", "TT_PERM"], "targetMembers": "all" | ["NomMembre"], "min": 0, "max": 2 }
3. "sequence_transition" (Enchaînement de jours, ex: lendemain de garde) :
   params: { "triggerTypes": ["GARDE_WE"], "offsetDays": 1, "mode": "forbid" | "require", "targetTypes": ["TT", "TT_PERM"], "targetMembers": "all" }
4. "max_consecutive_days" (Maximum de jours consécutifs d'un type) :
   params: { "targetTypes": ["TT", "TT_PERM"], "maxConsecutive": 2, "skipWeekends": false, "targetMembers": "all" }
5. "weekend_pair_consistency" (Même personne tout le weekend Samedi + Dimanche) :
   params: { "targetTypes": ["GARDE_WE"] }
6. "member_day_restriction" (Interdiction ou obligation certains jours de la semaine : 1=Lundi..5=Vendredi, 6=Samedi, 0=Dimanche) :
   params: { "daysOfWeek": [3], "mode": "forbid" | "require", "targetTypes": ["TT"], "targetMembers": ["Martine"] }
7. "member_compatibility" (Membres qui ne peuvent pas avoir le même type le même jour, ou doivent être ensemble) :
   params: { "dayFilter": "weekday", "mode": "not_together" | "together" | "at_least_one", "targetTypes": ["TT", "TT_PERM"], "targetMembers": ["Martine", "Louis"] }
8. "fairness_balance" (Équilibrage équitable des compteurs entre les membres) :
   params: { "targetTypes": ["TT", "TT_PERM", "GARDE_WE"], "targetMembers": "all" }

### 4. Règles actuellement actives (pour référence) :
${JSON.stringify(currentRules, null, 2)}

### 5. Instructions de réponse :
Réponds UNIQUEMENT avec un tableau JSON valide \`[ ... ]\` contenant l'ensemble des règles souhaitées, sans texte autour.
Voici les règles de mon organisation à encoder :
[DÉCRIVEZ VOS RÈGLES ICI EN FRANÇAIS]`;
}
