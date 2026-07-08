/**
 * Tree-sitter filetype parser config, ported from opencode's
 * `packages/tui/src/parsers-config.ts` (commit 5f61d214).
 *
 * This is pure data: an array of {@link FiletypeParserOptions} whose `wasm` and
 * `queries.*` fields are URLs that opentui fetches at runtime. It has no
 * top-level side effects and does NOT call `addDefaultParsers`; the orchestrator
 * owns that call.
 *
 * Differences from the opencode source:
 * - `queries.locals` is dropped on every entry. opentui's
 *   `FiletypeParserOptions.queries` shape only carries `highlights` and
 *   `injections`; there is no `locals`. Keeping it would be a type error and
 *   dead data.
 * - opentui bundles `javascript`, `typescript`, `markdown`, `markdown_inline`
 *   (and `zig`) natively, so those are intentionally absent here to avoid
 *   duplicating the bundled parsers. The opencode source already excludes them
 *   for the same reason.
 * - Grammar-repo `.scm` swaps (python/php/html/swift/lua) and the fork/ast-grep
 *   URLs (vue, clojure, nix) are preserved verbatim, as are the comments
 *   explaining why the nvim-treesitter query was swapped out.
 *
 * Source: https://raw.githubusercontent.com/sst/opencode/5f61d21487fad090a7bf4da95ab8211032b7768d/packages/tui/src/parsers-config.ts
 */

import type { FiletypeParserOptions } from '@opentui/core';

/**
 * Tree-sitter parser definitions for the languages opentui does NOT bundle
 * natively. Feed to `addDefaultParsers()` from the TUI orchestrator.
 */
export const TREE_SITTER_PARSERS: readonly FiletypeParserOptions[] = [
    {
        // nvim-treesitter's python highlights query is incompatible with the
        // upstream WASM parser (uses "except" nodes the parser rejects), so we
        // point at the grammar repo's own highlights.scm instead.
        filetype: 'python',
        wasm: 'https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.23.6/tree-sitter-python.wasm',
        queries: {
            highlights: [
                'https://github.com/tree-sitter/tree-sitter-python/raw/refs/heads/master/queries/highlights.scm',
            ],
        },
    },
    {
        filetype: 'rust',
        wasm: 'https://github.com/tree-sitter/tree-sitter-rust/releases/download/v0.24.0/tree-sitter-rust.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/rust/highlights.scm',
            ],
        },
    },
    {
        filetype: 'go',
        wasm: 'https://github.com/tree-sitter/tree-sitter-go/releases/download/v0.25.0/tree-sitter-go.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/go/highlights.scm',
            ],
        },
    },
    {
        filetype: 'cpp',
        wasm: 'https://github.com/tree-sitter/tree-sitter-cpp/releases/download/v0.23.4/tree-sitter-cpp.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/cpp/highlights.scm',
            ],
        },
    },
    {
        filetype: 'csharp',
        wasm: 'https://github.com/tree-sitter/tree-sitter-c-sharp/releases/download/v0.23.1/tree-sitter-c_sharp.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/c_sharp/highlights.scm',
            ],
        },
    },
    {
        filetype: 'bash',
        wasm: 'https://github.com/tree-sitter/tree-sitter-bash/releases/download/v0.25.0/tree-sitter-bash.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/bash/highlights.scm',
            ],
        },
    },
    {
        filetype: 'c',
        wasm: 'https://github.com/tree-sitter/tree-sitter-c/releases/download/v0.24.1/tree-sitter-c.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/c/highlights.scm',
            ],
        },
    },
    {
        filetype: 'java',
        wasm: 'https://github.com/tree-sitter/tree-sitter-java/releases/download/v0.23.5/tree-sitter-java.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/java/highlights.scm',
            ],
        },
    },
    {
        filetype: 'kotlin',
        wasm: 'https://github.com/fwcd/tree-sitter-kotlin/releases/download/0.3.8/tree-sitter-kotlin.wasm',
        queries: {
            highlights: ['https://raw.githubusercontent.com/fwcd/tree-sitter-kotlin/0.3.8/queries/highlights.scm'],
        },
    },
    {
        filetype: 'ruby',
        wasm: 'https://github.com/tree-sitter/tree-sitter-ruby/releases/download/v0.23.1/tree-sitter-ruby.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/ruby/highlights.scm',
            ],
        },
    },
    {
        // nvim-treesitter's php highlights query is incompatible with the
        // upstream WASM parser, so we point at the grammar repo's own
        // highlights.scm instead.
        filetype: 'php',
        wasm: 'https://github.com/tree-sitter/tree-sitter-php/releases/download/v0.24.2/tree-sitter-php.wasm',
        queries: {
            highlights: ['https://github.com/tree-sitter/tree-sitter-php/raw/refs/heads/master/queries/highlights.scm'],
        },
    },
    {
        filetype: 'scala',
        wasm: 'https://github.com/tree-sitter/tree-sitter-scala/releases/download/v0.24.0/tree-sitter-scala.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/scala/highlights.scm',
            ],
        },
    },
    {
        // nvim-treesitter's html highlights query is incompatible with the
        // upstream WASM parser, so we point at the grammar repo's own
        // highlights.scm instead. (Injections for <script>/<style> are left
        // off in the opencode source because they did not work there.)
        filetype: 'html',
        wasm: 'https://github.com/tree-sitter/tree-sitter-html/releases/download/v0.23.2/tree-sitter-html.wasm',
        queries: {
            highlights: [
                'https://github.com/tree-sitter/tree-sitter-html/raw/refs/heads/master/queries/highlights.scm',
            ],
        },
    },
    {
        filetype: 'vue',
        wasm: 'https://github.com/anomalyco/tree-sitter-vue/releases/download/v0.1.2/tree-sitter-vue.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/anomalyco/tree-sitter-vue/v0.1.2/queries/html_tags/highlights.scm',
                'https://raw.githubusercontent.com/anomalyco/tree-sitter-vue/v0.1.2/queries/vue/highlights.scm',
            ],
        },
    },
    {
        filetype: 'hcl',
        wasm: 'https://github.com/tree-sitter-grammars/tree-sitter-hcl/releases/download/v1.2.0/tree-sitter-hcl.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/master/queries/hcl/highlights.scm',
            ],
        },
    },
    {
        filetype: 'json',
        wasm: 'https://github.com/tree-sitter/tree-sitter-json/releases/download/v0.24.8/tree-sitter-json.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/json/highlights.scm',
            ],
        },
    },
    {
        filetype: 'yaml',
        wasm: 'https://github.com/tree-sitter-grammars/tree-sitter-yaml/releases/download/v0.7.2/tree-sitter-yaml.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/yaml/highlights.scm',
            ],
        },
    },
    {
        filetype: 'haskell',
        wasm: 'https://github.com/tree-sitter/tree-sitter-haskell/releases/download/v0.23.1/tree-sitter-haskell.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/haskell/highlights.scm',
            ],
        },
    },
    {
        filetype: 'css',
        wasm: 'https://github.com/tree-sitter/tree-sitter-css/releases/download/v0.25.0/tree-sitter-css.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/css/highlights.scm',
            ],
        },
    },
    {
        filetype: 'julia',
        wasm: 'https://github.com/tree-sitter/tree-sitter-julia/releases/download/v0.23.1/tree-sitter-julia.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/julia/highlights.scm',
            ],
        },
    },
    {
        // Grammar-repo (tree-sitter-grammars) query instead of nvim-treesitter.
        filetype: 'lua',
        wasm: 'https://github.com/tree-sitter-grammars/tree-sitter-lua/releases/download/v0.5.0/tree-sitter-lua.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-lua/v0.5.0/queries/highlights.scm',
            ],
        },
    },
    {
        filetype: 'ocaml',
        wasm: 'https://github.com/tree-sitter/tree-sitter-ocaml/releases/download/v0.24.2/tree-sitter-ocaml.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/ocaml/highlights.scm',
            ],
        },
    },
    {
        // Temporarily using the anomalyco fork to fix highlighting issues.
        filetype: 'clojure',
        wasm: 'https://github.com/anomalyco/tree-sitter-clojure/releases/download/v0.0.1/tree-sitter-clojure.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/clojure/highlights.scm',
            ],
        },
    },
    {
        // nvim-treesitter's swift highlights query uses #lua-match? predicates
        // that are incompatible with web-tree-sitter, so we point at the
        // parser repo's own highlights.scm instead.
        filetype: 'swift',
        wasm: 'https://github.com/alex-pinkus/tree-sitter-swift/releases/download/0.7.1/tree-sitter-swift.wasm',
        queries: {
            highlights: ['https://raw.githubusercontent.com/alex-pinkus/tree-sitter-swift/main/queries/highlights.scm'],
        },
    },
    {
        filetype: 'toml',
        wasm: 'https://github.com/tree-sitter-grammars/tree-sitter-toml/releases/download/v0.7.0/tree-sitter-toml.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/master/queries/toml/highlights.scm',
            ],
        },
    },
    {
        // No official tree-sitter-nix WASM release yet, so we use the
        // ast-grep-hosted WASM (see nix-community/tree-sitter-nix#66).
        filetype: 'nix',
        wasm: 'https://github.com/ast-grep/ast-grep.github.io/raw/40b84530640aa83a0d34a20a2b0623d7b8e5ea97/website/public/parsers/tree-sitter-nix.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/nix/highlights.scm',
            ],
        },
    },
    {
        filetype: 'diff',
        aliases: ['udiff', 'patch'],
        wasm: 'https://github.com/tree-sitter-grammars/tree-sitter-diff/releases/download/v0.1.0/tree-sitter-diff.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-diff/master/queries/highlights.scm',
            ],
        },
    },
    {
        filetype: 'elixir',
        wasm: 'https://github.com/elixir-lang/tree-sitter-elixir/releases/download/v0.3.5/tree-sitter-elixir.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/elixir/highlights.scm',
            ],
        },
    },
    {
        filetype: 'fsharp',
        wasm: 'https://github.com/ionide/tree-sitter-fsharp/releases/download/0.3.0/tree-sitter-fsharp.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/fsharp/highlights.scm',
            ],
        },
    },
    {
        filetype: 'r',
        wasm: 'https://github.com/r-lib/tree-sitter-r/releases/download/v1.2.0/tree-sitter-r.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/r/highlights.scm',
            ],
        },
    },
    {
        filetype: 'make',
        aliases: ['makefile'],
        wasm: 'https://github.com/tree-sitter-grammars/tree-sitter-make/releases/download/v1.1.1/tree-sitter-make.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/make/highlights.scm',
            ],
        },
    },
    {
        filetype: 'vim',
        wasm: 'https://github.com/tree-sitter-grammars/tree-sitter-vim/releases/download/v0.8.1/tree-sitter-vim.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/vim/highlights.scm',
            ],
        },
    },
    {
        filetype: 'xml',
        wasm: 'https://github.com/tree-sitter-grammars/tree-sitter-xml/releases/download/v0.7.0/tree-sitter-xml.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/xml/highlights.scm',
            ],
        },
    },
    {
        filetype: 'agda',
        wasm: 'https://github.com/tree-sitter/tree-sitter-agda/releases/download/v1.3.3/tree-sitter-agda.wasm',
        queries: {
            highlights: [
                'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/agda/highlights.scm',
            ],
        },
    },
] satisfies readonly FiletypeParserOptions[];
