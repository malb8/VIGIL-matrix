export async function runPolicyApplyTransaction({ snapshot, apply, rollback }) {
  const previous = await snapshot();
  try {
    return await apply();
  } catch (error) {
    try {
      await rollback(previous);
    } catch (_) {
      // Preserve the original compile/apply/persistence error for the caller.
    }
    throw error;
  }
}
