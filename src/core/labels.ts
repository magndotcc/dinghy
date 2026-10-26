import type { MachineSize } from "./pricing";

const SIZES: MachineSize[] = ["small", "default", "large", "xlarge"];

/**
 * Decide whether a job is ours and which machine it gets.
 * `runs-on: [self-hosted, dinghy]` → default size; `dinghy-large` → large.
 */
export function matchJob(labels: string[], label: string, fallback: MachineSize): MachineSize | null {
  const lower = labels.map((l) => l.toLowerCase());
  for (const l of lower) {
    if (l === label) {
      const sized = lower.map((x) => x.replace(`${label}-`, "")).find((x) => SIZES.includes(x as MachineSize));
      return (sized as MachineSize | undefined) ?? fallback;
    }
    if (l.startsWith(`${label}-`)) {
      const size = l.slice(label.length + 1);
      if (SIZES.includes(size as MachineSize)) return size as MachineSize;
    }
  }
  return null;
}
