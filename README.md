# 📅 Horaires d'Équipe (`ici.be/timetable`)

Application web statique de préparation des horaires d'équipe combinant :
1. **Les règles propres à l'organisation** (quotas quotidiens, quotas hebdomadaires, enchaînements après garde weekend, jours consécutifs, continuité weekend, équité...),
2. **Les désidératas des membres** (demandes de congé ou de télétravail, interdictions ponctuelles telles que *« pas de télétravail avec permanence matin »*).

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
  - Affiche par défaut les **3 prochaines semaines pleines** (Lundi au Dimanche).
  - Barre de réglages supérieure permettant de modifier les dates de début et de fin, d'avancer/reculer d'une semaine et d'aligner automatiquement sur des semaines pleines.
  - Distinction visuelle et logique entre **jours de semaine (Lundi–Vendredi)** et **weekends (Samedi–Dimanche)**.
- **Gestion de l'équipe et de la typologie des journées** :
  - Ajout/suppression de membres et de types de journées (`BUREAU`, `TT`, `TT_PERM`, `GARDE_WE`, `CONGE`, `REPOS`, ou tout type personnalisé).
  - Chaque type précise s'il s'applique en semaine (`weekday`), le weekend (`weekend`) ou les deux (`both`), et s'il est auto-assignable par le solveur.
- **Saisie des désidératas sur le calendrier** :
  - En cliquant sur un membre dans n'importe quel jour (ou via le **Pinceau de saisie rapide**), vous pouvez :
    - **Fixer / Demander un type** (ex. *Congé pour Martine le 23 juin*, *Télétravail pour Louis le 26*),
    - **Interdire un ou plusieurs types** (ex. *Pas de télétravail avec permanence du matin pour André le 24*).
- **Génération de propositions & alternatives** :
  - **✨ Générer une proposition** : résout les contraintes strictes (`hard`) et optimise l'équité (`soft`).
  - **🔄 Autre proposition** : génère une variante différente tout en respectant les règles, avec historique des propositions (`Proposition #1`, `#2`...) pour naviguer de l'une à l'autre.
  - **Modification unitaire assistée** : cliquez sur une attribution pour voir quels autres types sont **directement valides** (`✅`) ou **applicables avec ré-équilibrage automatique d'un collègue** (`🔄 Choisir & ré-équilibrer`).

---

## 🤖 Format générique des règles (compatible LLM externe)

L'onglet **🤖 Import / Prompt LLM** génère un prompt prêt à copier-coller dans n'importe quel LLM (ChatGPT, Claude, Mistral, Gemini) qui inclut votre équipe et votre typologie de journées, et permet d'importer le JSON généré.

### Les 8 primitives génériques (`kind`)

| `kind` | Rôle | Exemple de paramètres (`params`) |
| :--- | :--- | :--- |
| `daily_headcount` | Quotas par jour (min, max ou exact) | `{ "dayFilter": "weekday", "targetTypes": ["BUREAU"], "min": 3, "max": null }` |
| `member_period_count` | Quotas par membre par semaine ou sur la période | `{ "period": "week", "targetTypes": ["TT", "TT_PERM"], "targetMembers": "all", "min": 0, "max": 2 }` |
| `sequence_transition` | Enchaînement de jours (ex: lendemain de garde) | `{ "triggerTypes": ["GARDE_WE"], "offsetDays": 1, "mode": "forbid", "targetTypes": ["TT", "TT_PERM"] }` |
| `max_consecutive_days` | Nombre maximum de jours consécutifs | `{ "targetTypes": ["TT", "TT_PERM"], "maxConsecutive": 2, "skipWeekends": false }` |
| `weekend_pair_consistency` | Même personne Samedi et Dimanche | `{ "targetTypes": ["GARDE_WE"] }` |
| `member_day_restriction` | Règle récurrente certains jours de la semaine | `{ "daysOfWeek": [3], "mode": "forbid", "targetTypes": ["TT"], "targetMembers": ["Martine"] }` |
| `member_compatibility` | Incompatibilité ou binômage entre membres | `{ "dayFilter": "weekday", "mode": "not_together", "targetTypes": ["TT", "TT_PERM"], "targetMembers": ["Martine", "Louis"] }` |
| `fairness_balance` | Équilibrage équitable des compteurs entre membres | `{ "targetTypes": ["TT", "TT_PERM", "GARDE_WE"], "targetMembers": "all" }` |
