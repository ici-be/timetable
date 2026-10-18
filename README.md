# 📅 Horaires d'Équipe (`ici.be/timetable`)

Application web statique de préparation des horaires d'équipe combinant :
1. **Les règles propres à l'organisation** (quotas quotidiens, quotas hebdomadaires, enchaînements avant/après congé ou maladie, permanences, équilibre bureau/télétravail, équité...),
2. **Les désidératas des membres** (demandes de congé ou de télétravail, interdictions ponctuelles telles que *« pas de télétravail tel jour »*).

🔒 **100 % confidentiel & local** : aucune donnée n'est envoyée sur un serveur. Toute la configuration (membres, typologie des journées, règles, désidératas et propositions) est conservée dans le `localStorage` du navigateur, avec possibilité d'export CSV et de sauvegarde/restauration JSON.

---

## 🚀 Déploiement sur GitHub Pages (`https://github.com/ici-be/timetable`)

L'application utilise uniquement des standards web natifs (HTML5, CSS3, ES Modules JavaScript) avec des chemins relatifs (`./`). Elle ne nécessite **aucune étape de compilation (zero-build)** :

1. Poussez les fichiers à la racine de la branche `main` (ou `gh-pages`) du dépôt `https://github.com/ici-be/timetable`.
2. Dans **Settings ➔ Pages**, sélectionnez **Deploy from a branch** (`main` / `/ (root)`).
3. L'application est immédiatement accessible sur **`https://ici.be/timetable`** (ou `https://ici-be.github.io/timetable/`).

---

## ✨ Fonctionnalités principales

- **Calendrier avec une semaine par ligne** :
  - Affiche par défaut les **2 prochaines semaines pleines** (Lundi au Dimanche), avec sélecteur rapide permettant d'afficher de **1 à 12 semaines** (ou des dates libres).
  - Dans chaque journée du calendrier, les membres sont **triés par défaut par type de journée** (Bureau + permanences, Bureau, Télétravail, Congé, Maladie, Repos) avec possibilité de basculer vers un tri par personne.
  - Distinction visuelle et logique entre **jours de semaine (Lundi–Vendredi)** et **weekends (Samedi–Dimanche)**.
- **Gestion de l'équipe et de la typologie des journées** :
  - Ajout/suppression de membres et de types de journées (`BUREAU_MATIN`, `BUREAU_MIDI`, `BUREAU_SOIR`, `BUREAU`, `TT`, `CONGE`, `MALADIE`, `REPOS`, ou tout type personnalisé).
  - Chaque type précise s'il s'applique en semaine (`weekday`), le weekend (`weekend`) ou les deux (`both`), et s'il est auto-assignable par le solveur.
- **Saisie des désidératas sur le calendrier** :
  - En cliquant sur un membre dans n'importe quel jour (ou via le **Pinceau de saisie rapide**), vous pouvez :
    - **Fixer / Demander un type** (ex. *Congé pour Martine le 23 juin*, *Télétravail pour Louis le 26*),
    - **Interdire un ou plusieurs types** (ex. *Pas de télétravail pour André le 24*).
- **Génération de propositions & alternatives** :
  - **✨ Générer une proposition** : résout les contraintes strictes (`hard`) et optimise l'équité (`soft`).
  - **🔄 Autre proposition** : génère une variante différente tout en respectant les règles, avec historique des propositions (`Proposition #1`, `#2`...) pour naviguer de l'une à l'autre.
  - **Modification unitaire assistée** : cliquez sur une attribution pour voir quels autres types sont **directement valides** (`✅`) ou **applicables avec ré-équilibrage automatique d'un collègue** (`🔄 Choisir & ré-équilibrer`).

---

## 🤖 Format générique des règles (compatible LLM externe)

L'onglet **🤖 Import / Prompt LLM** génère un prompt prêt à copier-coller dans n'importe quel LLM (ChatGPT, Claude, Mistral, Gemini) qui inclut votre équipe et votre typologie de journées, et permet d'importer le JSON généré.

### Les 9 primitives génériques (`kind`)

| `kind` | Rôle | Exemple de paramètres (`params`) |
| :--- | :--- | :--- |
| `daily_headcount` | Quotas par jour (min, max ou exact) | `{ "dayFilter": "weekday", "targetTypes": ["BUREAU"], "min": 3, "max": null }` |
| `member_period_count` | Quotas par membre par semaine ou sur la période | `{ "period": "week", "targetTypes": ["TT", "TT_PERM"], "targetMembers": "all", "min": 0, "max": 2 }` |
| `sequence_transition` | Avant/après une séquence d'au moins N jours (ex: congé > 2 jours, lendemain de maladie) | `{ "triggerTypes": ["CONGE"], "minTriggerStreak": 3, "direction": "before", "offsetDays": -1, "skipWeekends": true, "mode": "forbid", "targetTypes": ["TT"] }` |
| `daily_balance` | Équilibrer chaque jour l'effectif de deux groupes (hors absences) | `{ "dayFilter": "weekday", "groupATypes": ["BUREAU", "BUREAU_MATIN", "BUREAU_MIDI", "BUREAU_SOIR"], "groupBTypes": ["TT"] }` |
| `max_consecutive_days` | Nombre maximum de jours consécutifs | `{ "targetTypes": ["TT", "TT_PERM"], "maxConsecutive": 2, "skipWeekends": false }` |
| `weekend_pair_consistency` | Même personne Samedi et Dimanche | `{ "targetTypes": ["GARDE_WE"] }` |
| `member_day_restriction` | Règle récurrente certains jours de la semaine | `{ "daysOfWeek": [3], "mode": "forbid", "targetTypes": ["TT"], "targetMembers": ["Martine"] }` |
| `member_compatibility` | Incompatibilité ou binômage entre membres | `{ "dayFilter": "weekday", "mode": "not_together", "targetTypes": ["TT", "TT_PERM"], "targetMembers": ["Martine", "Louis"] }` |
| `fairness_balance` | Équilibrage équitable des compteurs entre membres | `{ "targetTypes": ["TT", "TT_PERM", "GARDE_WE"], "targetMembers": "all" }` |

---

## 🏢 Cas par défaut (10 personnes fictives, 2 semaines)

Les permanences sont modélisées comme des **types de journée au bureau** (`BUREAU_MATIN`, `BUREAU_MIDI`, `BUREAU_SOIR`) : une personne en permanence est donc automatiquement comptée comme présente au bureau.

| Règle | Sévérité | Primitive |
| :--- | :--- | :--- |
| Max. 2 jours de télétravail par semaine et par personne | stricte | `member_period_count` |
| Min. 2 jours au bureau par semaine et par personne (prorata si absence) | stricte | `member_period_count` |
| Pas de télétravail le jour ouvré avant / après un congé de plus de 2 jours | stricte | `sequence_transition` (`minTriggerStreak: 3`) |
| Pas de télétravail le jour ouvré suivant une journée maladie | stricte | `sequence_transition` |
| Min. 4 personnes au bureau chaque jour de semaine | stricte | `daily_headcount` |
| Exactement 1 permanence matin, 1 midi, 1 soir chaque jour (parmi les présents) | stricte | `daily_headcount` |
| Équité des permanences (même nombre de chaque type par personne) | souhaitable | `fairness_balance` |
| Équilibre bureau / télétravail chaque jour (hors congé, maladie) | souhaitable | `daily_balance` |
| Répartition équitable du télétravail | souhaitable | `fairness_balance` |
