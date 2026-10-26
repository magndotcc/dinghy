export type MachineSize = "small" | "default" | "large" | "xlarge";

/** boat.dev list prices, USD per hour, billed per second. */
export const HOURLY_USD: Record<MachineSize, number> = {
  small: 0.018,
  default: 0.036,
  large: 0.072,
  xlarge: 0.2,
};

export const SPECS: Record<MachineSize, string> = {
  small: "2 vCPU · 4 GB",
  default: "4 vCPU · 8 GB",
  large: "8 vCPU · 16 GB",
  xlarge: "16 vCPU · 32 GB",
};

export function costUsd(size: MachineSize, seconds: number): number {
  return (HOURLY_USD[size] / 3600) * Math.max(0, seconds);
}

/** GitHub-hosted Linux list price per minute, for the "you saved" line. */
export const GITHUB_HOSTED_PER_MIN: Record<MachineSize, number> = {
  small: 0.008,
  default: 0.016,
  large: 0.032,
  xlarge: 0.064,
};
