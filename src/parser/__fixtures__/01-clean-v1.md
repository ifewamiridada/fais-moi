```json
{
  "format": "fais-moi/1",
  "plan": "30-Day PCOS Wellness",
  "start": "2026-09-28",
  "days": 30,
  "tz": "Africa/Lagos",
  "limits": { "per_day": 6, "quiet": "22:30-06:30" },
  "notifs": [
    {
      "id": "breakfast",
      "title": "Breakfast",
      "icon": "sun",
      "at": "08:00",
      "on": "daily",
      "priority": "gentle",
      "optional": false,
      "messages": ["Start with a protein-rich breakfast.", "Eggs, beans or yoghurt — pick one before 9.", "Add some fibre: oats or fruit."]
    },
    {
      "id": "hydration",
      "title": "Hydration check",
      "icon": "drop",
      "at": "11:00",
      "on": "weekdays",
      "optional": true,
      "messages": ["Glass of water before your next task.", "Refill your bottle."]
    },
    { "id": "lunch", "title": "Lunch check", "icon": "bowl", "at": "13:00", "on": "daily", "messages": ["Half the plate vegetables today."] },
    { "id": "move", "title": "Movement", "icon": "move", "at": "18:00", "on": "daily", "messages": ["20-minute walk — no phone."] },
    { "id": "reset", "title": "Mental reset", "icon": "moon", "at": "20:30", "on": "daily", "messages": ["What can you release today?"] },
    { "id": "faith", "title": "Faith grounding", "icon": "book", "at": "21:00", "on": "daily", "priority": "critical", "messages": ["Be still, and know."] },
    { "id": "meal-prep", "title": "Meal prep day", "at": "10:00", "on": "sat", "messages": ["Prep lunches for the week."] }
  ]
}
```
