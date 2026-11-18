-- Each package's last build or check, which the plan logs as what a needed one replaces
-- (infra/plan.py built): one seek, not every row of the package.
CREATE INDEX build_package_id ON build (package, id);
