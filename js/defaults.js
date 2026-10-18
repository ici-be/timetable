/**
 * Configuration par défaut pour l'application Horaires d'Équipe (ici.be/timetable)
 * Stockage 100% local dans le navigateur (localStorage).
 */

export const STORAGE_KEY = 'ici_be_timetable_state_v1';

/**
 * Calcule le prochain lundi (ou le lundi de la semaine courante)
 * et retourne une plage de 3 semaines pleines (Lundi -> Dimanche, 21 jours).
 */
export function getDefaultDateRange() {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const day = now.getDay(); // 0 = Dimanche, 1 = Lundi, ...
  // Trouver le lundi de la semaine prochaine (ou aujourd'hui si lundi)
  const diffToNextMonday = day === 1 ? 0 : (day === 0 ? 1 : 8 - day);
  const start = new Date(now);
  start.setDate(now.getDate() + diffToNextMonday);

  const end = new Date(start);
  end.setDate(start.getDate() + 20); // 3 semaines pleines = 21 jours (Lundi -> Dimanche)

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
  { id: 'm_martine', name: 'Martine', color: '#2563eb', role: 'Titulaire', active: true },
  { id: 'm_louis', name: 'Louis', color: '#059669', role: 'Titulaire', active: true },
  { id: 'm_andre', name: 'André', color: '#d97706', role: 'Titulaire', active: true },
  { id: 'm_sophie', name: 'Sophie', color: '#7c3aed', role: 'Titulaire', active: true },
  { id: 'm_karim', name: 'Karim', color: '#db2777', role: 'Titulaire', active: true },
  { id: 'm_claire', name: 'Claire', color: '#0891b2', role: 'Titulaire', active: true }
];

export const DEFAULT_DAY_TYPES = [
  {
    id: 'BUREAU',
    label: 'Travail sur place',
    shortLabel: 'Bureau',
    color: '#2563eb',
    bgColor: '#dbeafe',
    textColor: '#1e40af',
    dayScope: 'weekday', // 'weekday' | 'weekend' | 'both'
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
    id: 'TT_PERM',
    label: 'Télétravail + Perm. matin',
    shortLabel: 'TT + Perm.',
    color: '#0d9488',
    bgColor: '#ccfbf1',
    textColor: '#115e59',
    dayScope: 'weekday',
    autoAssign: true,
    isWorkingDay: true,
    isDefaultRest: false,
    tags: ['travail', 'teletravail', 'permanence']
  },
  {
    id: 'GARDE_WE',
    label: 'Garde weekend',
    shortLabel: 'Garde WE',
    color: '#d97706',
    bgColor: '#fef3c7',
    textColor: '#92400e',
    dayScope: 'weekend',
    autoAssign: true,
    isWorkingDay: true,
    isDefaultRest: false,
    tags: ['travail', 'garde', 'weekend']
  },
  {
    id: 'CONGE',
    label: 'Congé / Absence',
    shortLabel: 'Congé',
    color: '#e11d48',
    bgColor: '#ffe4e6',
    textColor: '#9f1239',
    dayScope: 'both',
    autoAssign: false, // Uniquement sur désidérata
    isWorkingDay: false,
    isDefaultRest: false,
    tags: ['absence', 'conge']
  },
  {
    id: 'REPOS',
    label: 'Repos / Off',
    shortLabel: 'Repos',
    color: '#64748b',
    bgColor: '#f1f5f9',
    textColor: '#334155',
    dayScope: 'both',
    autoAssign: false, // Par défaut les weekends hors garde
    isWorkingDay: false,
    isDefaultRest: true,
    tags: ['repos', 'off']
  }
];

export const DEFAULT_RULES = [
  {
    id: 'r_min_bureau',
    name: 'Minimum 3 personnes au bureau en semaine',
    description: 'Chaque jour ouvré (lundi au vendredi), au moins 3 membres doivent travailler sur place.',
    enabled: true,
    severity: 'hard',
    weight: 100,
    kind: 'daily_headcount',
    params: {
      dayFilter: 'weekday',
      targetTypes: ['BUREAU'],
      min: 3,
      max: null
    }
  },
  {
    id: 'r_perm_matin',
    name: '1 personne en télétravail avec permanence matin par jour',
    description: 'Chaque jour de semaine, exactement 1 personne assure la permanence du matin en télétravail.',
    enabled: true,
    severity: 'hard',
    weight: 90,
    kind: 'daily_headcount',
    params: {
      dayFilter: 'weekday',
      targetTypes: ['TT_PERM'],
      min: 1,
      max: 1
    }
  },
  {
    id: 'r_garde_we_quota',
    name: '1 personne de garde chaque jour du weekend',
    description: 'Chaque samedi et dimanche, exactement 1 personne est de garde weekend.',
    enabled: true,
    severity: 'hard',
    weight: 100,
    kind: 'daily_headcount',
    params: {
      dayFilter: 'weekend',
      targetTypes: ['GARDE_WE'],
      min: 1,
      max: 1
    }
  },
  {
    id: 'r_garde_we_pair',
    name: 'Même personne de garde tout le weekend',
    description: 'La personne de garde le samedi assure également la garde du dimanche.',
    enabled: true,
    severity: 'hard',
    weight: 95,
    kind: 'weekend_pair_consistency',
    params: {
      targetTypes: ['GARDE_WE']
    }
  },
  {
    id: 'r_no_tt_after_garde',
    name: 'Pas de télétravail après une garde weekend',
    description: 'Un membre qui a effectué la garde du weekend ne peut pas être en télétravail (classique ou avec permanence) le lundi suivant.',
    enabled: true,
    severity: 'hard',
    weight: 100,
    kind: 'sequence_transition',
    params: {
      triggerTypes: ['GARDE_WE'],
      offsetDays: 1,
      mode: 'forbid',
      targetTypes: ['TT', 'TT_PERM']
    }
  },
  {
    id: 'r_max_tt_semaine',
    name: 'Maximum 2 jours de télétravail par semaine par personne',
    description: 'Chaque membre peut faire au maximum 2 jours de télétravail (TT ou TT + Perm.) par semaine.',
    enabled: true,
    severity: 'hard',
    weight: 85,
    kind: 'member_period_count',
    params: {
      period: 'week',
      targetTypes: ['TT', 'TT_PERM'],
      min: 0,
      max: 2
    }
  },
  {
    id: 'r_equite_tt',
    name: 'Répartition équitable du télétravail et des gardes',
    description: 'Équilibre le nombre de télétravails, permanences matin et gardes weekend entre les membres sur la période.',
    enabled: true,
    severity: 'soft',
    weight: 50,
    kind: 'fairness_balance',
    params: {
      targetTypes: ['TT', 'TT_PERM', 'GARDE_WE']
    }
  }
];
