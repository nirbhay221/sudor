/**
 * The Agent Skill, handed out by the server it is about.
 *
 * `skills/` holds an Agent Skill (agentskills.io): a SKILL.md that tells an assistant when to use this add-on,
 * which tool answers which sentence, how to follow a chain and how to say the answer, with its reference files
 * beside it. A skill is normally installed from a folder. An assistant that has only connected to the server has
 * no folder, so every file is also published here as an MCP resource, and a host can read the skill from the
 * same connection it calls the tools on.
 *
 * The addresses follow the `skill://<name>/<path>` form of the Skills over MCP draft (SEP-2640). Only resources
 * are used, which every MCP host already reads; the draft's own methods are not final and are not implemented.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const ROOT = resolve('./skills');
const TYPES: Record<string, string> = { md: 'text/markdown', mjs: 'text/javascript', js: 'text/javascript', json: 'application/json', txt: 'text/plain' };

export type SkillFile = { uri: string; skill: string; path: string; mimeType: string; text: string; sha256: string };

function walk(dir: string, under = ''): string[] {
  return readdirSync(dir).sort().flatMap((entry) => {
    const rel = under ? `${under}/${entry}` : entry;
    return statSync(join(dir, entry)).isDirectory() ? walk(join(dir, entry), rel) : [rel];
  });
}

/** Every file of every skill in `skills/`, read once. A folder without a SKILL.md is not a skill and is left out. */
export function skillFiles(root = ROOT): SkillFile[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().flatMap((skill) => {
    const dir = join(root, skill);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'SKILL.md'))) return [];
    return walk(dir).map((path) => {
      // Line endings are normalised so the digest is the same from a Windows checkout as from the server.
      const text = readFileSync(join(dir, path), 'utf8').replace(/\r\n/g, '\n');
      return {
        uri: `skill://${skill}/${path}`,
        skill,
        path,
        mimeType: TYPES[path.split('.').pop() ?? ''] ?? 'text/plain',
        text,
        sha256: createHash('sha256').update(text).digest('hex'),
      };
    });
  });
}

/** The `description` from a SKILL.md's frontmatter, which is what a host shows before it loads the rest. */
export function describe(skillMd: string): { name: string; description: string } {
  const front = /^---\n([\s\S]*?)\n---/.exec(skillMd)?.[1] ?? '';
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front)?.[1].trim() ?? '';
  return { name: field('name'), description: field('description') };
}

/*
 * Read once. The server builds a new MCP server for every request, and reading the folder each time put a disk
 * read in front of every answer; the files only change with a deploy, which restarts the process.
 */
let cached: SkillFile[] | null = null;
const loaded = (): SkillFile[] => (cached ??= skillFiles());

export function registerSkills(server: McpServer, files = loaded()): void {
  for (const f of files) {
    const main = f.path === 'SKILL.md';
    const about = main ? describe(f.text) : null;
    server.registerResource(
      `skill:${f.skill}/${f.path}`,
      f.uri,
      {
        title: main ? `Agent Skill: ${f.skill}` : `${f.skill}: ${f.path}`,
        description: about?.description ?? `Part of the ${f.skill} Agent Skill. Read it when SKILL.md points to it.`,
        mimeType: f.mimeType,
        _meta: { 'io.modelcontextprotocol/skills': { skill: f.skill, path: f.path, sha256: f.sha256 } },
      },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: f.mimeType, text: f.text }] }),
    );
  }
}
