import { startOmrWorker } from './omr-worker';
import { readRuntimeOmrLimits } from './runtime-omr-config';
import { validateSealedWorkerEnvironment, verifySealedNativeRuntime } from './sealed-native-runtime';

async function main() {
  const env = process.env;
  validateSealedWorkerEnvironment(env);
  const limits = readRuntimeOmrLimits(env);
  await verifySealedNativeRuntime();
  const service = await startOmrWorker({
    socketPath: env.MAESTIVO_AUDIVERIS_SOCKET || '',
    jobRoot: env.MAESTIVO_OMR_JOB_ROOT || '',
    binaryPath: env.MAESTIVO_AUDIVERIS_BINARY || '',
    timeoutMs: limits.timeoutMs,
    tessdataPath: env.TESSDATA_PREFIX,
    sealedNative: true,
  });
  console.info('MAESTIVO isolated OMR worker is listening on its private Unix socket.');
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
    void service.close().then(() => process.exit(0), () => {
      // A stuck cleanup is a failure, never a successful shutdown. systemd
      // retains its own control-group stop deadline for any remaining child.
      console.error('MAESTIVO OMR worker did not finish shutdown cleanup.');
      process.exitCode = 1;
    });
  });
}
void main().catch(() => { console.error('MAESTIVO isolated OMR worker failed to start.'); process.exit(1); });
