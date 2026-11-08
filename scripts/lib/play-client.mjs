// Shared Google Play Developer API client helpers.
import { accessSync, constants } from 'node:fs';
import { androidpublisher, auth as googleAuth } from '@googleapis/androidpublisher';

export class PlayAuthError extends Error {}

export async function getPublisher() {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile) {
    throw new PlayAuthError('GOOGLE_APPLICATION_CREDENTIALS is not set. See docs/setup.md step 1.');
  }
  try {
    accessSync(keyFile, constants.R_OK);
  } catch {
    throw new PlayAuthError('GOOGLE_APPLICATION_CREDENTIALS points to a file that cannot be read. See docs/setup.md step 1.');
  }
  const auth = new googleAuth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
  return androidpublisher({ version: 'v3', auth });
}

export function explainApiError(err, packageName) {
  // Numeric HTTP status only: codes like 'ENOENT' are not statuses.
  const status = Number(err?.response?.status ?? err?.status ?? err?.code) || undefined;
  const apiMsg = err?.errors?.[0]?.message ?? err?.response?.data?.error?.message ?? err?.message ?? 'unknown error';
  if (err instanceof PlayAuthError) return err.message;
  if (status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(apiMsg)) {
    return `Play API denied access (403): the Google Play Android Developer API is not enabled in the service account's Google Cloud project. Enable the Google Play Android Developer API there (docs/setup.md step 1), wait a few minutes, then retry. API said: ${apiMsg}`;
  }
  if (status === 401 || status === 403) {
    return `Play API denied access (${status}). The service account lacks access to this app; see docs/setup.md step 2. API said: ${apiMsg}`;
  }
  if (status === 404) {
    return `Play API: not found (404). Check that "${packageName}" is the right package name and the app exists in Play Console. API said: ${apiMsg}`;
  }
  if (status === 400) return `Play API rejected the request (400): ${apiMsg}`;
  return status ? `Play API error (${status}): ${apiMsg}` : apiMsg;
}

// Edit lifecycle. A failed cleanup delete never masks the real outcome: an uncommitted
// edit holds no changes and expires on Google's side, so delete errors are swallowed,
// including after a successful dry run.
export async function withEdit(publisher, packageName, fn, { commit = false } = {}) {
  const { data } = await publisher.edits.insert({ packageName, requestBody: {} });
  const editId = data.id;
  let result;
  try {
    result = await fn(editId);
    if (commit === true) {
      await publisher.edits.commit({ packageName, editId });
      return result;
    }
  } catch (err) {
    await publisher.edits.delete({ packageName, editId }).catch(() => {});
    throw err;
  }
  await publisher.edits.delete({ packageName, editId }).catch(() => {});
  return result;
}
