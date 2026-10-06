import * as http from 'node:http';
import * as https from 'node:https';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

/**
 * Minimal Docker Engine API client.
 *
 * Talks to a Docker daemon over its HTTP API using only node:http/https, so a
 * build host needs a reachable daemon but no `docker` CLI installed — point
 * TM_DOCKER_HOST at a remote engine, a TLS endpoint, or a unix socket.
 *
 * Also the reason builds do not bind-mount the project: a remote daemon has a
 * different filesystem, so `${projDir}:/work` would resolve against the wrong
 * host. Instead the tree is uploaded per container and the output is downloaded,
 * which means the container has *no* host filesystem access at all.
 */
export interface DockerTarget {
  protocol: 'http:' | 'https:';
  host?: string;
  port?: number;
  socketPath?: string;
  basePath: string;
}

export function dockerTarget(): DockerTarget {
  const raw = (process.env.TM_DOCKER_HOST || 'unix:///var/run/docker.sock').trim();
  if (raw.startsWith('unix://')) {
    return {
      protocol: 'http:',
      socketPath: raw.slice('unix://'.length),
      basePath: '',
    };
  }
  const u = new URL(raw.includes('://') ? raw : `tcp://${raw}`);
  return {
    protocol: u.protocol === 'https:' ? 'https:' : 'http:',
    host: u.hostname,
    port: u.port ? Number(u.port) : u.protocol === 'https:' ? 2376 : 2375,
    basePath: '/v1.43',
  };
}

function ca(): Buffer | undefined {
  const p = process.env.TM_DOCKER_CA;
  if (!p) return undefined;
  try {
    return readFileSync(p);
  } catch {
    return undefined;
  }
}

/** Response plus the API path it came from, so errors can name the failing call. */
export type DockerResponse = import('node:http').IncomingMessage & { dockerPath?: string };

/** Open a request against the daemon. Caller owns the response stream. */
export function dockerRequest(
  method: string,
  pathname: string,
  opts: { headers?: Record<string, string>; body?: Buffer | NodeJS.ReadableStream; timeoutMs?: number } = {}
): Promise<DockerResponse> {
  const t = dockerTarget();
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  const token = process.env.TM_DOCKER_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/octet-stream';

  const isHttps = t.protocol === 'https:';
  const lib = isHttps ? https : http;
  const requestOptions: https.RequestOptions = {
    method,
    path: `${t.basePath}${pathname}`,
    headers,
    ...(t.socketPath ? { socketPath: t.socketPath } : { host: t.host, port: t.port }),
  };
  if (isHttps) {
    requestOptions.rejectUnauthorized = process.env.TM_DOCKER_TLS_VERIFY !== '0';
    const c = ca();
    if (c) requestOptions.ca = c;
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(requestOptions, (r) => {
      (r as DockerResponse).dockerPath = pathname;
      resolve(r as DockerResponse);
    });
    req.on('error', reject);
    if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(new Error('docker request timed out')));
    if (opts.body && typeof (opts.body as NodeJS.ReadableStream).pipe === 'function') {
      (opts.body as NodeJS.ReadableStream).on('error', (e) => req.destroy(e));
      (opts.body as NodeJS.ReadableStream).pipe(req);
    } else {
      if (opts.body) req.write(opts.body);
      req.end();
    }
  });
}

/** Consume a response, rejecting on non-2xx. Returns the raw stream. */
export async function dockerOk(res: DockerResponse): Promise<DockerResponse> {
  const status = res.statusCode || 0;
  if (status >= 200 && status < 300) return res;
  const body = await new Promise<string>((r) => {
    let s = '';
    res.on('data', (c) => (s += c));
    res.on('end', () => r(s.slice(0, 400)));
    res.on('error', () => r(''));
  });
  res.resume();
  throw new Error(`docker API ${status} ${res.dockerPath || ''}: ${body.trim() || '(empty)'}`);
}

export async function ping(): Promise<boolean> {
  try {
    const t = dockerTarget();
    const lib = t.protocol === 'https:' ? https : http;
    const options: https.RequestOptions = {
      method: 'GET',
      path: '/_ping',
      ...(t.socketPath ? { socketPath: t.socketPath } : { host: t.host, port: t.port }),
    };
    if (t.protocol === 'https:') {
      options.rejectUnauthorized = process.env.TM_DOCKER_TLS_VERIFY !== '0';
      const c = ca();
      if (c) options.ca = c;
    }
    await new Promise<void>((resolve, reject) => {
      const req = lib.request(options, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('ping timeout')));
      req.end();
    });
    return true;
  } catch {
    return false;
  }
}

export async function imageExists(image: string): Promise<boolean> {
  try {
    await dockerOk(await dockerRequest('GET', `/images/${encodeURIComponent(image)}/json`));
    return true;
  } catch {
    return false;
  }
}

/** Pull an image. The response is a JSON progress stream; drain it. */
export async function pullImage(image: string, onLog?: (s: string) => void): Promise<void> {
  const slash = image.lastIndexOf('/');
  const fromImage = slash === -1 ? image : image.slice(0, slash);
  const tag = slash === -1 ? 'latest' : image.slice(slash + 1);
  const res = await dockerOk(
    await dockerRequest(
      'POST',
      `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
      { timeoutMs: 10 * 60_000 }
    )
  );
  await new Promise<void>((resolve, reject) => {
    let tail = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-300);
      onLog?.('');
    });
    res.on('end', resolve);
    res.on('error', reject);
    void tail;
  });
}

export interface CreateSpec {
  name?: string;
  image: string;
  cmd: string[];
  workdir: string;
  /** env pairs */
  env: string[];
  user?: string;
  network?: string;
  memoryBytes?: number;
  nanoCpus?: number;
  pidsLimit?: number;
  capDrop?: string[];
  securityOpt?: string[];
  tmpfs?: Record<string, string>;
  /** publish containerPort -> host, e.g. { "3000/tcp": { hostIp, hostPort } } */
  portBindings?: Record<string, { hostIp: string; hostPort: string }>;
  exposedPorts?: string[];
}

export async function createContainer(spec: CreateSpec): Promise<string> {
  const hostConfig: Record<string, unknown> = {
    NetworkMode: spec.network || 'bridge',
    AutoRemove: false,
  };
  if (spec.memoryBytes) hostConfig.Memory = spec.memoryBytes;
  if (spec.nanoCpus) hostConfig.NanoCpus = spec.nanoCpus;
  if (spec.pidsLimit) hostConfig.PidsLimit = spec.pidsLimit;
  if (spec.capDrop) hostConfig.CapDrop = spec.capDrop;
  if (spec.securityOpt) hostConfig.SecurityOpt = spec.securityOpt;
  if (spec.tmpfs) hostConfig.Tmpfs = spec.tmpfs;
  if (spec.portBindings) {
    const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
    for (const [c, h] of Object.entries(spec.portBindings)) bindings[c] = [{ HostIp: h.hostIp, HostPort: h.hostPort }];
    hostConfig.PortBindings = bindings;
  }

  const body = Buffer.from(
    JSON.stringify({
      Image: spec.image,
      // Tty merges stdout/stderr and strips Docker's 8-byte frame headers, so
      // the log stream can be forwarded verbatim as build output.
      Tty: true,
      OpenStdin: false,
      StdinOnce: false,
      Cmd: spec.cmd,
      WorkingDir: spec.workdir,
      Env: spec.env,
      User: spec.user || '',
      ExposedPorts: spec.exposedPorts,
      Labels: { 'tm.role': 'build' },
      HostConfig: hostConfig,
    })
  );

  const res = await dockerOk(await dockerRequest('POST', '/containers/create', { body }));
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { Id: string };
  return json.Id;
}

/** Upload a tar stream into a created (not yet started) container. */
export async function putArchive(id: string, path: string, tar: NodeJS.ReadableStream): Promise<void> {
  const res = await dockerRequest('PUT', `/containers/${id}/archive?path=${encodeURIComponent(path)}`, {
    body: tar,
    timeoutMs: 10 * 60_000,
  });
  await dockerOk(res);
}

export async function startContainer(id: string): Promise<void> {
  await dockerOk(await dockerRequest('POST', `/containers/${id}/start`, { timeoutMs: 60_000 }));
}

/** Inspect a container, e.g. to read back which host port a mapping landed on. */
export async function inspectContainer(id: string): Promise<{
  State?: { Running?: boolean; ExitCode?: number; Status?: string };
  NetworkSettings?: { Ports?: Record<string, { HostIp: string; HostPort: string }[] | null> };
}> {
  const res = await dockerOk(await dockerRequest('GET', `/containers/${id}/json`, { timeoutMs: 15_000 }));
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function containerLogs(
  id: string,
  onData: (chunk: string) => void
): Promise<import('node:http').IncomingMessage> {
  const res = await dockerOk(
    await dockerRequest('GET', `/containers/${id}/logs?follow=1&stdout=1&stderr=1&timestamps=0`)
  );
  res.setEncoding('utf8');
  res.on('data', onData);
  return res;
}

/** Resolves with the container's exit code. */
export async function waitContainer(id: string): Promise<number> {
  const res = await dockerOk(await dockerRequest('POST', `/containers/${id}/wait?condition=not_running`));
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { StatusCode: number };
  return json.StatusCode;
}

/** Stream a path out of a finished container as a tar. */
export async function getArchive(id: string, path: string): Promise<import('node:http').IncomingMessage> {
  return dockerOk(
    await dockerRequest('GET', `/containers/${id}/archive?path=${encodeURIComponent(path)}`, { timeoutMs: 10 * 60_000 })
  );
}

export async function removeContainer(id: string): Promise<void> {
  try {
    await dockerOk(await dockerRequest('DELETE', `/containers/${id}?force=1&v=1`));
  } catch {
    /* already gone */
  }
}