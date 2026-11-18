# The tools the justfile needs beyond pnpm and uv: terraform, just and redocly (which lints the
# API's OpenAPI spec), and for just dev,
# sops and age, and git-lfs for the reader's screenshots. nix develop puts them on PATH. CI adds
# packages.ci to PATH (.github/actions/setup): tools with Node, pnpm and uv, fetched in one build.
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      fs = nixpkgs.lib.fileset;
      # Part of the Node workspace, with its lock files, but not what doesn't reach a Worker:
      # Markdown, tests and the screenshots (whose baselines are in git LFS, so a checkout
      # without them would differ)
      nodeSource =
        dirs:
        fs.toSource {
          root = ./.;
          fileset = fs.difference
            (fs.unions ([ ./package.json ./pnpm-lock.yaml ./pnpm-workspace.yaml ] ++ dirs))
            (fs.unions [
              ./reader/screenshots
              (fs.fileFilter (f: f.hasExt "md" || nixpkgs.lib.hasSuffix ".test.ts" f.name) ./.)
            ]);
        };
      # The contents infra/plan.py's graph hashes, beside the builds' out paths
      sources = {
        worker = nodeSource [ ./api ./ingest ./oauth-proxy ./reader ./shared ./util ];
        # What the ingest Worker is bundled from; bundling it builds its container images
        # (wrangler's dry run)
        ingest = nodeSource [ ./ingest ./shared ./util ];
        # What deploy-infra applies to an environment: Terraform's resources (not shared/ or
        # tokens/, their own environments) and the D1 migrations
        infra = fs.toSource {
          root = ./.;
          fileset = fs.unions [
            (fs.difference (fs.fileFilter (f: f.hasExt "tf") ./infra) (fs.unions [ ./infra/shared ./infra/tokens ]))
            ./infra/.terraform.lock.hcl
            ./infra/terraformrc
            ./infra/tf.sh
            ./infra/wrangler.sh
            ./api/migrations
            ./api/lexicon-migrations
            ./ingest/migrations
          ];
        };
        infra-shared = fs.toSource {
          root = ./.;
          fileset = fs.unions [
            ./infra/shared
            ./infra/terraformrc
            ./infra/tf.sh
          ];
        };
        curated = fs.toSource {
          root = ./.;
          fileset = ./curated;
        };
        # What just check and just test read: all of it but docs and the screenshots'
        # baselines, which are in git LFS, so a checkout without them would differ
        repo = fs.toSource {
          root = ./.;
          fileset = fs.difference ./. (fs.unions [
            (fs.maybeMissing ./docs)
            ./reader/screenshots/__screenshots__
            (fs.fileFilter (f: f.hasExt "md") ./.)
          ]);
        };
      };

      # HashiCorp's release: nixpkgs builds terraform from source, as it's unfree (BUSL),
      # which takes minutes in each CI job
      terraformVersion = "1.17.1";
      terraformZips = {
        x86_64-linux = {
          platform = "linux_amd64";
          hash = "sha256-RjhigFjnGlUhKxxWNxLqwDuQISj0B0Dz3IF03xITUGE=";
        };
        aarch64-linux = {
          platform = "linux_arm64";
          hash = "sha256-mI6VChwjBYCTsOZqstX7U/wYNF7PvVhxrPUduskyXt0=";
        };
        aarch64-darwin = {
          platform = "darwin_arm64";
          hash = "sha256-seyz/g0KApDBq2+D2WfUPyXaBdC2ce4Ps1UlImjc6Vo=";
        };
      };

      perSystem =
        system: zip:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          terraform = pkgs.stdenvNoCC.mkDerivation {
            pname = "terraform";
            version = terraformVersion;
            src = pkgs.fetchurl {
              url = "https://releases.hashicorp.com/terraform/${terraformVersion}/terraform_${terraformVersion}_${zip.platform}.zip";
              inherit (zip) hash;
            };
            nativeBuildInputs = [ pkgs.unzip ];
            sourceRoot = ".";
            dontStrip = true;
            installPhase = "install -Dm755 terraform $out/bin/terraform";
          };
          # The skolia Worker as just deploy-web uploads it: the reader's assets and the API
          # bundled by wrangler, as the bundle test builds it (justfile build). Its out path
          # is its key (infra/plan.py). The version isn't in it: deploy-web sets VERSION as a var.
          skolia-worker = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
            pname = "skolia-worker";
            version = "0";
            src = sources.worker;
            # The lock file's packages. When pnpm-lock.yaml changes this hash does too: set
            # it to "" and take the one the build reports.
            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              pnpm = pkgs.pnpm_11;
              fetcherVersion = 5;
              hash = "sha256-C7rPT+nDLWBxsRBQ55ulQocyiGXUaPthakCGqjY6TXk=";
            };
            nativeBuildInputs = [
              pkgs.nodejs_24
              pkgs.pnpm_11
              pkgs.pnpmConfigHook
            ];
            buildPhase = ''
              runHook preBuild
              export HOME=$TMPDIR WRANGLER_SEND_METRICS=false
              pnpm --filter @skolia/reader build
              (cd api && pnpm exec wrangler deploy --dry-run --outdir "$TMPDIR/worker" --env="")
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              install -Dm644 "$TMPDIR/worker/main.js" "$out/worker/main.js"
              cp -r reader/dist "$out/assets"
              runHook postInstall
            '';
          });
          tools = pkgs.buildEnv {
            name = "skolia-tools";
            paths = [
              terraform
              pkgs.just
              pkgs.redocly
            ];
          };
        in
        {
          # infra/plan.py's, in one nix eval
          keys = builtins.mapAttrs (_: source: "${source}") sources // {
            skolia-worker = skolia-worker.outPath;
          };
          packages.tools = tools;
          packages.skolia-worker = skolia-worker;
          packages.ci = pkgs.buildEnv {
            name = "skolia-ci";
            paths = [
              tools
              pkgs.nodejs_24
              pkgs.pnpm_11
              pkgs.uv
            ];
          };
          devShells.default = pkgs.mkShellNoCC {
            packages = [
              tools
              pkgs.sops
              pkgs.age
              pkgs.git-lfs
            ];
          };
        };
      systems = builtins.mapAttrs perSystem terraformZips;
    in
    {
      keys = builtins.mapAttrs (_: s: s.keys) systems;
      packages = builtins.mapAttrs (_: s: s.packages) systems;
      devShells = builtins.mapAttrs (_: s: s.devShells) systems;
    };
}
