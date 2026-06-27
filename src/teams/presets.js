// Team presets — ready-made rosters for common kinds of work. A preset is just a team.json the user
// can launch as-is or tweak in the builder. Engineers own the repo (rw "."); reviewers are read-only;
// media makers (designer/sound/composer) write their own asset sub-trees.
export const PRESETS = {
  'game': {
    title: 'Game dev',
    description: 'engineer + critic, plus graphics / sound / music makers',
    teams: [{ name: 'game', territory: '.', members: [
      { role: 'architect', backend: 'claude', lead: true },
      { role: 'engineer', backend: 'claude' },
      { role: 'critic', backend: 'claude' },
      { role: 'designer', backend: 'gemini', territory: 'assets/img' },
      { role: 'sound-designer', backend: 'elevenlabs', territory: 'assets/sfx' },
      { role: 'composer', backend: 'elevenlabs', territory: 'assets/music' },
    ] }],
  },
  'web': {
    title: 'E-commerce / web dev',
    description: 'engineer + critic + user-defender + tester + a UI graphics designer',
    teams: [{ name: 'web', territory: '.', members: [
      { role: 'architect', backend: 'claude', lead: true },
      { role: 'engineer', backend: 'claude' },
      { role: 'critic', backend: 'claude' },
      { role: 'user-defender', backend: 'claude' },
      { role: 'tester', backend: 'claude', territory: 'tests' },
      { role: 'designer', backend: 'gemini', territory: 'public/img' },
    ] }],
  },
  'mobile': {
    title: 'Mobile app dev',
    description: 'engineer + critic + user-defender + tester + a graphics designer',
    teams: [{ name: 'app', territory: '.', members: [
      { role: 'architect', backend: 'claude', lead: true },
      { role: 'engineer', backend: 'claude' },
      { role: 'critic', backend: 'claude' },
      { role: 'user-defender', backend: 'claude' },
      { role: 'tester', backend: 'claude', territory: 'tests' },
      { role: 'designer', backend: 'gemini', territory: 'assets' },
    ] }],
  },
  'backend': {
    title: 'Backend dev',
    description: 'engineer with hard reviewers (ultracritical + adversary)',
    teams: [{ name: 'api', territory: '.', members: [
      { role: 'architect', backend: 'claude', lead: true },
      { role: 'engineer', backend: 'claude' },
      { role: 'ultracritical', backend: 'claude' },
      { role: 'adversary', backend: 'claude' },
    ] }],
  },
}

export function listPresets() {
  return Object.entries(PRESETS).map(([name, p]) => ({ name, title: p.title, description: p.description }))
}

// Build a roster (team.json shape) from a preset, stamped with the org name.
export function buildPreset(name, { org } = {}) {
  const p = PRESETS[name]
  if (!p) throw new Error(`unknown preset "${name}". Try: ${Object.keys(PRESETS).join(', ')}`)
  return { org: org || name, teams: JSON.parse(JSON.stringify(p.teams)) }
}
