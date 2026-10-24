import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProjectSite } from './lib/project-site.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await buildProjectSite(path.join(root, '.output/userscript-site'));
console.log('Project homepage and local assets built in .output/userscript-site.');
