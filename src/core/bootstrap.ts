export const RUNNER_DIR = "/home/user/actions-runner";
export const JIT_PATH = "/home/user/.dinghy/jit";

/** Installs the GitHub Actions runner unless the snapshot already has it. */
export function installRunner(version: string): string {
  return `
if [ ! -x ${RUNNER_DIR}/run.sh ]; then
  mkdir -p ${RUNNER_DIR}
  case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; *) arch=x64 ;; esac
  curl -fsSL "https://github.com/actions/runner/releases/download/v${version}/actions-runner-linux-\${arch}-${version}.tar.gz" \\
    | tar xz -C ${RUNNER_DIR}
  sudo ${RUNNER_DIR}/bin/installdependencies.sh >/dev/null || true
fi`;
}

/** Setup script for a runner sandbox. It runs one job, then exits; dinghy deletes the sandbox. */
export function runnerScript(version: string, preScript: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
exec >>/tmp/dinghy-runner.log 2>&1
echo "[dinghy] boot $(date -Is)"
${installRunner(version)}
${preScript ? `# --- DINGHY_PRE_SCRIPT ---\n${preScript}\n# ---` : ""}
cd ${RUNNER_DIR}
jit="$(cat ${JIT_PATH})"
rm -f ${JIT_PATH}
echo "[dinghy] runner starting $(date -Is)"
./run.sh --jitconfig "$jit"
echo "[dinghy] runner exited $? $(date -Is)"
`;
}

/** Setup script for the one-off bake sandbox that becomes the saved snapshot. */
export function bakeScript(version: string, extra: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
exec >>/tmp/dinghy-bake.log 2>&1
sudo sed -i 's#http://[a-z.]*archive.ubuntu.com#http://fr.archive.ubuntu.com#g' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null || true
${installRunner(version)}
${extra ? `# --- DINGHY_BAKE_SCRIPT ---\n${extra}\n# ---` : ""}
sync
echo "[dinghy] bake done $(date -Is)"
`;
}
