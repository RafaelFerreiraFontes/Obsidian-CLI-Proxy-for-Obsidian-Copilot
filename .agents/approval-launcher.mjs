// AGY resolves hook commands relative to .agents. Resolve the built handler from
// this module, preserving paths with spaces and Unicode without shell interpolation.
try {
  await import(new URL('../dist/approval-hook.js', import.meta.url).href);
} catch {
  console.log(JSON.stringify({ decision: 'deny', reason: 'Approval handler unavailable.' }));
  process.exitCode = 1;
}