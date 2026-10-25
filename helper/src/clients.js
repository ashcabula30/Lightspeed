// Client guides: the knowledge base's clients/*.md pages, read fresh on every request so edits
// to the knowledge base show up in the panel without restarting the helper.
import fs from 'node:fs';
import path from 'node:path';

function clientsDir(config) {
  return path.join(config.knowledgeBase, 'clients');
}

function titleOf(markdown, fallback) {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

export function listClients(config) {
  const dir = clientsDir(config);
  if (!fs.existsSync(dir)) return { dir, clients: [] };
  const clients = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const id = f.replace(/\.md$/, '');
    return { id, name: titleOf(fs.readFileSync(path.join(dir, f), 'utf8'), id) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { dir, clients };
}

export function getClient(config, id) {
  if (!/^[\w-]+$/.test(String(id))) throw new Error('Unknown client.');
  const file = path.join(clientsDir(config), `${id}.md`);
  if (!fs.existsSync(file)) throw new Error(`No guide for ${id} in the knowledge base.`);
  const markdown = fs.readFileSync(file, 'utf8');
  return { id, name: titleOf(markdown, id), markdown };
}
