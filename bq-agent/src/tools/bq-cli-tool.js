import { exec } from 'child_process';
import { DynamicTool } from "@langchain/core/tools";

/**
 * Executes a BigQuery command-line (bq) command.
 * @param {string} command - The bq CLI command to execute (e.g., "ls --project_id=my-project", "show --dataset=my_dataset").
 * @returns {Promise<string>} A promise that resolves to the stdout of the command, or an error message.
 */
async function runBqCliCommand(command) {
  console.log(`\n🤖 Executing bq CLI command: bq ${command}\n`);
  return new Promise((resolve, reject) => {
    // The `bq` command is expected to be in the PATH of the Cloud Shell environment.
    exec(`bq ${command}`, (error, stdout, stderr) => {
      if (error) {
        console.error(`ERROR executing bq command: ${error.message}`);
        reject(`Error executing bq command: ${error.message}\nStderr: ${stderr}`);
        return;
      }
      if (stderr) {
        // bq often prints warnings to stderr even on success, so we'll log it as a warning.
        console.warn(`WARN from bq command: ${stderr}`);
      }
      resolve(stdout.trim()); // Trim to remove any leading/trailing whitespace
    });
  });
}

export const bqCliTool = new DynamicTool({
  name: "bq_cli_tool",
  description: `
    Useful for executing BigQuery command-line (bq) commands to get metadata.
    Use this specifically for:
    - **Listing datasets** in a project (e.g., input: "ls --project_id=my-project-id").
    - **Listing tables** in a dataset (e.g., input: "ls --project_id=my-project-id my_dataset").
    - **Getting detailed info/schema** for a specific dataset or table (e.g., input: "show --dataset=my_dataset --table=my_table").
    The input to this tool MUST be a valid 'bq' command string, WITHOUT the 'bq' prefix.
    Example: To list datasets in project 'my-project', the input should be "ls --project_id=my-project".
  `,
  func: runBqCliCommand,
});