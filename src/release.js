export async function publishReleaseTransaction(github, parameters) {
  let draft;
  try {
    draft = await github.createDraftRelease(parameters);
    for (const asset of parameters.assets) {
      await github.uploadAsset(draft.id, asset);
    }
    return await github.publishRelease(draft.id, parameters.makeLatest);
  } catch (error) {
    if (draft) {
      try {
        const current = await github.getRelease(draft.id);
        if (current.draft) await github.deleteRelease(draft.id);
      } catch (rollbackError) {
        error.message += ` Rollback check failed: ${rollbackError.message}`;
      }
    }
    throw error;
  }
}
