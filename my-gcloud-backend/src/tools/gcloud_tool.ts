/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *	http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Tool } from "@langchain/core/tools";
import * as child_process from 'child_process';
import {
  AccessControlList,
  createAccessControlList,
} from '../denylist';
import * as gcloud from '../gcloud';
import type { RunnableConfig } from "@langchain/core/runnables";
import type { CallbackManagerForToolRun } from "@langchain/core/callbacks/manager";


// Denylist any command that is interactive or requires a TTY.
// These commands will hang the process.
const defaultDeny = [
  'sftp',
  'ssh',
  'docker', // Requires configuring docker-credential-gcr.
  'gen-repo-info-file',
];

const accessControl = createAccessControlList([], defaultDeny);

class GoogleCloudSDK extends Tool {
    name = 'google-cloud-sdk';
    description = `Executes a command for a Google Cloud command-line interface: gcloud, gsutil, kubectl, or bq. Input should be the full command string.`;

    async _call(
      commandString: string,
      runManager?: CallbackManagerForToolRun,
      config?: RunnableConfig
    ): Promise<string> {
      // BUILD_MARKER: V6 - Linter Removed
      console.log(`[GCLOUD_TOOL_LOG] Raw command string from agent: "${commandString}"`);

      const allArgs = commandString.trim().split(' ');
      const tool = allArgs[0];
      const args = allArgs.slice(1);

      if (!["gcloud", "gsutil", "kubectl", "bq"].includes(tool)) {
        return `Error: Invalid tool '${tool}'. The first word of the command must be one of gcloud, gsutil, kubectl, or bq.`;
      }

      const userAccessToken = config?.configurable?.userAccessToken;
      const env = { ...process.env };
      if (userAccessToken) {
          console.log('[GCLOUD_TOOL] Setting CLOUDSDK_AUTH_ACCESS_TOKEN in environment.');
          env['CLOUDSDK_AUTH_ACCESS_TOKEN'] = userAccessToken;
      }

      const projectIndex = args.findIndex(arg => arg === '--project');
      if (projectIndex !== -1 && projectIndex + 1 < args.length) {
          const projectId = args[projectIndex + 1];
          console.log(`[GCLOUD_TOOL] Found --project flag on initial args. Forcing CLOUDSDK_CORE_PROJECT to: ${projectId}`);
          env['CLOUDSDK_CORE_PROJECT'] = projectId;
      }

      const accessControlResult = accessControl.check(args.join(' '));
      if (accessControlResult.permitted === false) {
        return accessControlResult.message;
      }
    
      // --- LINTER REMOVED ---
      // The gcloud.lint() step was interfering with the --project flag and is the root cause of the issue.
      // Bypassing it for direct execution.
      console.log('[GCLOUD_TOOL] Bypassing linter and using raw arguments.');
      const cleanArgs = args;
      // --- END LINTER REMOVAL ---
    
      const command = {
        tool: tool,
        args: cleanArgs,
      };
    
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';

        const child = child_process.spawn(command.tool, command.args, {
          env,
        });
    
        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });
    
        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });
    
        child.on('close', (code) => {
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] Command: '${command.tool} ${command.args.join(' ')}'`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] Exit Code: ${code}`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] STDOUT: ${stdout}`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] STDERR: ${stderr}`);

          if (code === 0) {
            if (stdout.trim() === '') {
                resolve("Command executed successfully and returned no output.");
            } else {
                resolve(stdout);
            }
          } else {
            resolve(`Error: Command failed with exit code ${code}. Stderr: ${stderr}`);
          }
        });
    
        child.on('error', (err) => {
          resolve(`Failed to start the ${command.tool} process: ${err.message}`);
        });
      });
    }
}

export const googleCloudSdkTool = new GoogleCloudSDK();
