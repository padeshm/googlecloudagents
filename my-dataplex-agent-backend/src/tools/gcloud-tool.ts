
import { exec } from 'child_process';
import { DynamicTool } from "@langchain/core/tools";

/**
 * Executes a gcloud command. 
 * The function correctly accepts a plain string, which is what the AgentExecutor provides.
 */
async function runGcloudCliCommand(command: string): Promise<string> {
  console.log(`\n🤖 Correctly received command string. Executing: gcloud ${command}\n`);

  // A simple validation to ensure the input is a usable string.
  if (!command || typeof command !== 'string') {
    const errorMessage = `Tool Error: Expected a command string, but received an invalid input.`;
    console.error(errorMessage);
    return errorMessage; // Return the error for the agent to process.
  }

  return new Promise((resolve) => {
    // We use a Promise to handle the asynchronous nature of the 'exec' command.
    // We will always 'resolve' the promise, even with an error message, 
    // so the agent can process the tool's output instead of crashing.
    exec(`gcloud ${command}`, (error, stdout, stderr) => {
      if (error) {
        // This indicates a process-level error (e.g., command not found).
        const errorMessage = `Execution Error: ${error.message}\nStderr: ${stderr}`;
        console.error(errorMessage);
        resolve(errorMessage);
        return;
      }

      if (stderr && !stdout) {
        // This handles cases where gcloud returns warnings or non-fatal errors.
        const stderrMessage = `Command returned no output on stdout, but had this on stderr: ${stderr}`;
        console.warn(stderrMessage);
        resolve(stderr.trim());
        return;
      }

      // This is the successful execution path.
      console.log(`gcloud command successful, stdout:\n${stdout}`);
      resolve(stdout.trim());
    });
  });
}

export const gcloudTool = new DynamicTool({
  name: "gcloud_cli_tool",
  description: `
    Executes Google Cloud (gcloud) commands.
    The input to this tool MUST be a plain string containing the command to execute (without the 'gcloud' prefix).
    Example: "dataplex datascans list --project=my-project-id"
  `,
  func: runGcloudCliCommand,
});
