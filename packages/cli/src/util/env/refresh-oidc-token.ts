import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import output from '../../output-manager';
import type Client from '../../util/client';
import {
  type EnvRecordsSource,
  pullEnvRecords,
} from '../../util/env/get-env-records';
import sleep from '../../util/sleep';
import { CONTENTS_PREFIX } from './constants';

const VERCEL_OIDC_TOKEN = 'VERCEL_OIDC_TOKEN';
const REFRESH_BEFORE_EXPIRY_MS = 15 * 60_000; // 15 minutes

export function refreshOidcToken(
  client: Client,
  projectId: string,
  envValues: Record<string, string>,
  source: EnvRecordsSource
): () => void {
  const initialOidcToken = envValues[VERCEL_OIDC_TOKEN];
  if (!initialOidcToken) {
    output.debug(
      `${VERCEL_OIDC_TOKEN} is absent from environment variables; will not attempt to refresh it`
    );
    return () => {};
  }

  let timeout: NodeJS.Timeout;

  async function go(initialOidcToken?: string) {
    let oidcToken = initialOidcToken;

    if (!oidcToken) {
      const envRecords = await untilSuccessful(
        () => pullEnvRecords(client, projectId, source),
        60_000
      );
      oidcToken = envRecords.env[VERCEL_OIDC_TOKEN];
    }

    if (!oidcToken) {
      output.debug(
        `${VERCEL_OIDC_TOKEN} is absent from environment variables; will not attempt to refresh it`
      );
      return;
    }

    const exp = getExpFromOidcToken(oidcToken);
    if (exp === null) {
      output.debug(
        `Cannot extract "exp" claim from ${VERCEL_OIDC_TOKEN}; will not attempt to refresh it`
      );
      return;
    }

    const expiresAfterMs = exp * 1000 - new Date().getTime();
    if (!Number.isFinite(expiresAfterMs)) {
      output.debug(
        `${VERCEL_OIDC_TOKEN} "exp" claim is invalid; will not attempt to refresh it`
      );
      return;
    }

    let refreshAfterMs = expiresAfterMs - REFRESH_BEFORE_EXPIRY_MS;
    if (expiresAfterMs < 0) {
      refreshAfterMs = 0;
      output.debug(
        `${VERCEL_OIDC_TOKEN} expired ${Math.abs(expiresAfterMs)} milliseconds ago; attempting to refresh it`
      );
    } else if (refreshAfterMs < 0) {
      refreshAfterMs = 0;
      output.debug(
        `${VERCEL_OIDC_TOKEN} expires in ${expiresAfterMs} milliseconds; attempting to refresh it`
      );
    } else {
      output.debug(
        `${VERCEL_OIDC_TOKEN} expires in ${expiresAfterMs} milliseconds; will attempt to refresh it in ${refreshAfterMs} milliseconds`
      );
    }

    // If this isn't our initial OIDC token and it isn't already expired, go
    // ahead and write it to the local environment. We only write the OIDC
    // token, and nothing else.
    if (!initialOidcToken && expiresAfterMs > 0) {
      // TODO(mroberts): Is this the only file we should patch?
      const filename = '.env.local';
      try {
        await patchLocalEnv(client.cwd, filename, VERCEL_OIDC_TOKEN, oidcToken);
      } catch (error) {
        output.debug(`Failed to patch ${VERCEL_OIDC_TOKEN} in ${filename}`);
      }
    }

    // TODO(mroberts): There could be a case where we keep receiving a stale
    // token, and end up looping excessively. Try to throttle here.
    timeout = setTimeout(() => void go(), expiresAfterMs);
  }

  timeout = setTimeout(() => void go(initialOidcToken));

  return () => clearTimeout(timeout);
}

function getExpFromOidcToken(oidcToken: string): number | null {
  const payloadBase64 = oidcToken.split('.')[1];
  if (!payloadBase64) {
    return null;
  }

  let payloadJson: unknown;
  try {
    const payloadString = Buffer.from(payloadBase64, 'base64').toString('utf8');
    payloadJson = JSON.parse(payloadString);
  } catch (error) {
    return null;
  }

  if (typeof payloadJson !== 'object' || payloadJson === null) {
    return null;
  }

  if (!('exp' in payloadJson) || typeof payloadJson.exp !== 'number') {
    return null;
  }

  return payloadJson.exp;
}

// TODO(mroberts): Hook up an AbortSignal here?
async function untilSuccessful<T>(
  fn: () => Promise<T>,
  ms: number
): Promise<T> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      output.debug(`Fetching ${VERCEL_OIDC_TOKEN}`);
      return await fn();
    } catch (error) {
      output.debug(
        `Failed to fetch ${VERCEL_OIDC_TOKEN}; trying again in ${ms} milliseconds`
      );
      await sleep(ms);
    }
  }
}

async function patchLocalEnv(
  cwd: string,
  filename: string,
  key: string,
  value: string
): Promise<void> {
  const fullPath = resolve(cwd, filename);

  const localEnv = await readFile(fullPath, { encoding: 'utf8' });
  if (!localEnv.startsWith(CONTENTS_PREFIX)) {
    output.debug(
      `${filename} does not start with "${CONTENTS_PREFIX}"; will not update ${key}`
    );
  }

  const regExp = new RegExp(`^${key}=.*$`, 'm');
  let newLocalEnv = localEnv.replace(regExp, `${key}="${value}"`);
  if (newLocalEnv === localEnv) {
    output.debug(`${filename} does not contain ${key}; adding it`);
    if (!newLocalEnv.endsWith('\n')) {
      newLocalEnv += '\n';
    }
    newLocalEnv += `${key}="${value}"`;
  } else {
    output.debug(`${filename} contains ${key}; updating it`);
  }

  await writeFile(fullPath, newLocalEnv);
}
