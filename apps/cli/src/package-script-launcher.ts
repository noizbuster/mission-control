import { runCli } from './index';

const argv = process.argv.slice(2);
await runCli(argv, argv[0] === '--');
