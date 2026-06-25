// --import preload that registers the ESM resolve hook used by the --no-tui
// module-graph trace. See scripts/verify-no-tui-keymap-graph.mjs.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(pathToFileURL('./scripts/tui-keymap-trace-hooks.mjs').href, import.meta.url);
