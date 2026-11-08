# data/

Engine-neutral content. Both the Three.js game and a possible Godot port read these files.
Filled in during Phases 2 to 4:

| File or folder | Holds |
| --- | --- |
| `props/` | One JSON recipe per prop: the simple shapes it is built from, materials, size, tags, which slots it fits |
| `archetypes.json` | Room types and the dials the layout generator turns |
| `rules.json` | Room mechanics and their parameters |
| `themes/` | World bible and narrator voice guide |
| `prompts/` | Prompt templates with {placeholders} |
| `schemas/` | JSON Schemas for what the model returns |
| `tasks.json` | The office tasks' fixed wording: narrator instructions, door labels, desk items, the colleague's and workers' lines. Safe to edit, but every player should hear the same measured instruction, so change it between test sessions, not during one |
