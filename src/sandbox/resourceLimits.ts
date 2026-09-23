// Resource-limit value validation shared by Run creation (src/runs/runService.ts) and preset
// validation (src/presets/validatePreset.ts) -- docs/crew/role-presets.md section 3.3: "Invalid
// CPU, memory and disk values are rejected before the Run is inserted." Pure functions, no I/O.

/**
 * Parse a CPU limit: a positive decimal, the only form `docker --cpus` accepts.
 * Returns null when the value is not a valid positive decimal.
 */
export function parseCpuLimit(v: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

/**
 * Parse a memory or disk limit: a positive integer with an optional single-letter binary suffix
 * (b/k/m/g, case-insensitive), matching what the sandbox manager passes to docker/podman
 * (`--memory 512m`, `--storage-opt size=10g`). Returns null when the value does not parse.
 */
export function parseByteLimit(v: string): number | null {
  const m = /^(\d+)([bkmg])?$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}
