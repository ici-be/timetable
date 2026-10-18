/**
 * Configuration par défaut pour l'application Horaires d'Équipe (ici.be/timetable)
 * Stockage 100% local dans le navigateur (localStorage).
 */

export const STORAGE_KEY = 'ici_be_timetable_state_v5';

export const DEFAULT_WEEKS_COUNT = 2;

/**
 * Calcule le prochain lundi (ou le lundi de la semaine courante)
 * et retourne une plage de N semaines pleines (par défaut 2 semaines : Lundi -> Dimanche, 14 jours).
 */
export function getDefaultDateRange(weeksCount = DEFAULT_WEEKS_COUNT) {
  const validWeeks = Math.max(1, Math.min(26, Number(weeksCount) || DEFAULT_WEEKS_COUNT));
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const day = now.getDay(); // 0 = Dimanche, 1 = Lundi, ...
  // Trouver le lundi de la semaine prochaine (ou aujourd'hui si lundi)
  const diffToNextMonday = day === 1 ? 0 : (day === 0 ? 1 : 8 - day);
  const start = new Date(now);
  start.setDate(now.getDate() + diffToNextMonday);

  const end = new Date(start);
  end.setDate(start.getDate() + validWeeks * 7 - 1);

  return {
    startDate: formatDateISO(start),
    endDate: formatDateISO(end)
  };
}

export function formatDateISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export const DEFAULT_MEMBERS = [
  { id: 'm_ludivine', name: 'Ludivine', color: '#2563eb', role: 'Équipe', active: true },
  { id: 'm_evelyne', name: 'Evelyne', color: '#059669', role: 'Équipe', active: true },
  { id: 'm_isabelle', name: 'Isabelle', color: '#d97706', role: 'Équipe', active: true },
  { id: 'm_isa', name: 'Isa', color: '#7c3aed', role: 'Équipe', active: true },
  { id: 'm_bruno', name: 'Bruno', color: '#db2777', role: 'Équipe', active: true },
  { id: 'm_jeremie', name: 'Jérémie', color: '#0891b2', role: 'Équipe', active: true },
  { id: 'm_maud', name: 'Maud', color: '#4f46e5', role: 'Équipe', active: true },
  { id: 'm_xaviere', name: 'Xavière', color: '#ea580c', role: 'Équipe', active: true },
  { id: 'm_monique', name: 'Monique', color: '#0d9488', role: 'Équipe', active: true },
  { id: 'm_inge', name: 'Inge', color: '#9333ea', role: 'Équipe', active: true },
  { id: 'm_lila', name: 'Lila', color: '#e11d48', role: 'Équipe', active: true }
];

export const DEFAULT_DAY_TYPES = [
  {
    id: 'BUREAU_MATIN',
    label: 'Bureau + Perm. matin',
    shortLabel: 'Bur. Matin',
    color: '#16a34a',
    bgColor: '#dcfce7',
    textColor: '#15803d',
    dayScope: 'weekday',
    autoAssign: true,
    isWorkingDay: true,
    isDefaultRest: false,
    tags: ['travail', 'presentiel', 'bureau', 'permanence', 'perm_matin']
  },
  {
    id: 'BUREAU_MIDI',
    label: 'Bureau + Perm. midi',
    shortLabel: 'Bur. Midi',
    color: '#9333ea',
    bgColor: '#f3e8ff',
    textColor: '#7e22ce',
    dayScope: 'weekday',
    autoAssign: true,
    isWorkingDay: true,
    isDefaultRest: false,
    tags: ['travail', 'presentiel', 'bureau', 'permanence', 'perm_midi']
  },
  {
    id: 'BUREAU_SOIR',
    label: 'Bureau + Perm. soir',
    shortLabel: 'Bur. Soir',
    color: '#dc2626',
    bgColor: '#fee2e2',
    textColor: '#b91c1c',
    dayScope: 'weekday',
    autoAssign: true,
    isWorkingDay: true,
    isDefaultRest: false,
    tags: ['travail', 'presentiel', 'bureau', 'permanence', 'perm_soir']
  },
  {
    id: 'BUREAU',
    label: 'Travail au bureau',
    shortLabel: 'Bureau',
    color: '#2563eb',
    bgColor: '#dbeafe',
    textColor: '#1e40af',
    dayScope: 'weekday',
    autoAssign: true,
    isWorkingDay: true,
    isDefaultRest: false,
    tags: ['travail', 'presentiel', 'bureau']
  },
  {
    id: 'TT',
    label: 'Télétravail',
    shortLabel: 'Télétravail',
    color: '#059669',
    bgColor: '#d1fae5',
    textColor: '#065f46',
    dayScope: 'weekday',
    autoAssign: true,
    isWorkingDay: true,
    isDefaultRest: false,
    tags: ['travail', 'teletravail']
  },
  {
    id: 'CONGE',
    label: 'Congé',
    shortLabel: 'Congé',
    color: '#d97706',
    bgColor: '#fef3c7',
    textColor: '#92400e',
    dayScope: 'both',
    autoAssign: false, // Uniquement sur désidérata
    isWorkingDay: false,
    isDefaultRest: false,
    tags: ['absence', 'conge']
  },
  {
    id: 'MALADIE',
    label: 'Maladie',
    shortLabel: 'Maladie',
    color: '#e11d48',
    bgColor: '#ffe4e6',
    textColor: '#9f1239',
    dayScope: 'both',
    autoAssign: false, // Uniquement sur désidérata
    isWorkingDay: false,
    isDefaultRest: false,
    tags: ['absence', 'maladie']
  },
  {
    id: 'REPOS',
    label: 'Repos / Weekend',
    shortLabel: 'Repos',
    color: '#64748b',
    bgColor: '#f1f5f9',
    textColor: '#334155',
    dayScope: 'both',
    autoAssign: false, // Par défaut les weekends
    isWorkingDay: false,
    isDefaultRest: true,
    tags: ['repos', 'off']
  }
];

export const DEFAULT_RULES = [
  {
    id: 'r_max_tt_semaine',
    name: 'Maximum 2 jours de télétravail par semaine par personne',
    description: 'Chaque personne peut effectuer au maximum 2 jours de télétravail par semaine.',
    enabled: true,
    severity: 'hard',
    weight: 100,
    kind: 'member_period_count',
    params: {
      period: 'week',
      dayFilter: 'weekday',
      targetTypes: ['TT'],
      targetMembers: 'all',
      min: 0,
      max: 2
    }
  },
  {
    id: 'r_min_bureau_semaine',
    name: 'Minimum 2 jours au bureau par semaine par personne',
    description: 'Chaque personne doit travailler au moins 2 jours au bureau par semaine (incluant les permanences au bureau, ajusté au prorata si congé/maladie).',
    enabled: true,
    severity: 'hard',
    weight: 100,
    kind: 'member_period_count',
    params: {
      period: 'week',
      dayFilter: 'weekday',
      targetTypes: ['BUREAU', 'BUREAU_MATIN', 'BUREAU_MIDI', 'BUREAU_SOIR'],
      targetMembers: 'all',
      min: 2,
      max: null
    }
  },
  {
    id: 'r_min_bureau_jour',
    name: 'Minimum 4 personnes au bureau chaque jour de semaine',
    description: 'Chaque jour ouvré (lundi au vendredi), au moins 4 personnes doivent être présentes au bureau (avec ou sans permanence).',
    enabled: true,
    severity: 'hard',
    weight: 100,
    kind: 'daily_headcount',
    params: {
      dayFilter: 'weekday',
      targetTypes: ['BUREAU', 'BUREAU_MATIN', 'BUREAU_MIDI', 'BUREAU_SOIR'],
      min: 4,
      max: null
    }
  },
  {
    id: 'r_perm_matin',
    name: '1 permanence du matin au bureau chaque jour',
    description: 'Parmi les personnes au bureau, exactement 1 personne assure la permanence du matin chaque jour de semaine.',
    enabled: true,
    severity: 'hard',
    weight: 100,
    kind: 'daily_headcount',
    params: {
      dayFilter: 'weekday',
      targetTypes: ['BUREAU_MATIN'],
      min: 1,
      max: 1
    }
  },
  {
    id: 'r_perm_midi',
    name: '1 permanence du midi au bureau chaque jour',
    description: 'Parmi les personnes au bureau, exactement 1 personne assure la permanence du midi chaque jour de semaine.',
    enabled: true,
    severity: 'hard',
    weight: 100,
    kind: 'daily_headcount',
    params: {
      dayFilter: 'weekday',
      targetTypes: ['BUREAU_MIDI'],
      min: 1,
      max: 1
    }
  },
  {
    id: 'r_perm_soir',
    name: '1 permanence du soir au bureau chaque jour',
    description: 'Parmi les personnes au bureau, exactement 1 personne assure la permanence du soir chaque jour de semaine.',
    enabled: true,
    severity: 'hard',
    weight: 100,
    kind: 'daily_headcount',
    params: {
      dayFilter: 'weekday',
      targetTypes: ['BUREAU_SOIR'],
      min: 1,
      max: 1
    }
  },
  {
    id: 'r_no_tt_before_long_conge',
    name: 'Pas de télétravail avant un congé de plus de 2 jours',
    description: 'Le jour ouvré précédant immédiatement un congé d\'au moins 3 jours consécutifs ne peut pas être en télétravail.',
    enabled: true,
    severity: 'hard',
    weight: 100,
    kind: 'sequence_transition',
    params: {
      triggerTypes: ['CONGE'],
      minTriggerStreak: 3,
      direction: 'before',
      offsetDays: -1,
      skipWeekends: true,
      mode: 'forbid',
      targetTypes: ['TT'],
      targetMembers: 'all'
    }
  },
  {
    id: 'r_no_tt_after_long_conge',
    name: 'Pas de télétravail après un congé de plus de 2 jours',
    description: 'Le jour ouvré suivant immédiatement un congé d\'au moins 3 jours consécutifs ne peut pas être en télétravail.',
    enabled: true,
    severity: 'hard',
    weight: 100,
    kind: 'sequence_transition',
    params: {
      triggerTypes: ['CONGE'],
      minTriggerStreak: 3,
      direction: 'after',
      offsetDays: 1,
      skipWeekends: true,
      mode: 'forbid',
      targetTypes: ['TT'],
      targetMembers: 'all'
    }
  },
  {
    id: 'r_no_tt_after_maladie',
    name: 'Après une journée maladie, pas de télétravail le lendemain',
    description: 'Un membre en maladie un jour donné ne peut pas être en télétravail le jour ouvré suivant.',
    enabled: true,
    severity: 'hard',
    weight: 100,
    kind: 'sequence_transition',
    params: {
      triggerTypes: ['MALADIE'],
      minTriggerStreak: 1,
      direction: 'after',
      offsetDays: 1,
      skipWeekends: true,
      mode: 'forbid',
      targetTypes: ['TT'],
      targetMembers: 'all'
    }
  },
  {
    id: 'r_equite_permanences',
    name: 'Équité des permanences (Matin, Midi, Soir) sur la période',
    description: 'Même nombre de permanences de chaque type (Matin, Midi, Soir) et au global pour chaque personne sur la période.',
    enabled: true,
    severity: 'soft',
    weight: 100,
    kind: 'fairness_balance',
    params: {
      targetTypes: ['BUREAU_MATIN', 'BUREAU_MIDI', 'BUREAU_SOIR'],
      targetMembers: 'all'
    }
  },
  {
    id: 'r_equilibre_jour_bureau_tt',
    name: 'Équilibrer le nombre de personnes au bureau et en télétravail chaque jour',
    description: 'Chaque jour ouvré (hors congé et maladie), recherche l\'équilibre entre l\'effectif au bureau et l\'effectif en télétravail.',
    enabled: true,
    severity: 'soft',
    weight: 75,
    kind: 'daily_balance',
    params: {
      dayFilter: 'weekday',
      groupATypes: ['BUREAU', 'BUREAU_MATIN', 'BUREAU_MIDI', 'BUREAU_SOIR'],
      groupBTypes: ['TT']
    }
  },
  {
    id: 'r_equite_tt',
    name: 'Répartition équitable du télétravail entre les membres',
    description: 'Équilibre le nombre de jours de télétravail entre les personnes sur la période.',
    enabled: true,
    severity: 'soft',
    weight: 60,
    kind: 'fairness_balance',
    params: {
      targetTypes: ['TT'],
      targetMembers: 'all'
    }
  },
  {
    id: 'r_no_consecutive_weekends',
    name: 'Pas de service weekend deux weekends de suite',
    description: 'Une même personne ne peut pas assurer un service (gardes ou permanences weekend) deux weekends consécutifs.',
    enabled: true,
    severity: 'hard',
    weight: 100,
    kind: 'max_consecutive_weekends',
    params: {
      targetTypes: ['REPOS'],
      maxConsecutiveWeekends: 1,
      mode: 'forbid_service',
      targetMembers: 'all'
    }
  }
];
