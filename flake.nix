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
      # What the skolia Worker is bundled from
      workerSource = nodeSource [ ./api ./ingest ./oauth-proxy ./reader ./shared ./util ];
      # infra/plan.py's graph: { node = [ path ... ]; } to each node's paths as one source's
      # store path, its content hash. Not Markdown, nor the screenshots' baselines, which are
      # in git LFS, so a checkout without them would differ (plan.py hashes their git tree).
      # A path git doesn't track is left out.
      hashes = builtins.mapAttrs (
        _: paths:
        "${fs.toSource {
          root = ./.;
          fileset = fs.difference (fs.unions (map (path: fs.maybeMissing (./. + "/${path}")) paths)) (
            fs.unions [
              (fs.fileFilter (f: f.hasExt "md") ./.)
              ./reader/screenshots/__screenshots__
            ]
          );
        }}"
      );

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
            src = workerSource;
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
      # infra/plan.py's, in one nix eval
      planner = {
        inherit hashes;
        worker = builtins.mapAttrs (_: s: s.packages.skolia-worker.outPath) systems;
      };
      packages = builtins.mapAttrs (_: s: s.packages) systems;
      devShells = builtins.mapAttrs (_: s: s.devShells) systems;
    };
}
