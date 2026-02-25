#!/usr/bin/env node

import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerDevCommand } from "./commands/dev.js";
import { registerMigrationCommand } from "./commands/migration.js";
import { registerDbCommand } from "./commands/db.js";
import { registerGenerateCommand } from "./commands/generate.js";

const program = new Command();

program
  .name("pgstack")
  .description(
    "Postgres-native backend platform. One PostgreSQL. Zero extra containers."
  )
  .version("0.1.0");

registerInitCommand(program);
registerDevCommand(program);
registerMigrationCommand(program);
registerDbCommand(program);
registerGenerateCommand(program);

program.parse();
