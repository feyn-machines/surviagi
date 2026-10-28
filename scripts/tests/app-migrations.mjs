/** Strip psql directives before a Node pg client executes migration SQL. */
export function appMigrationSql(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\\set\s+ON_ERROR_STOP\s+on\s*$/.test(line))
    .join("\n");
}
