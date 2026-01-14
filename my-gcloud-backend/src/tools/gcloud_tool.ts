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
      // BUILD_MARKER: V15 - Definitive Fix for sign-url context
      console.log(`[GCLOUD_TOOL_LOG] Raw command string from agent: "${commandString}"`);

      const allArgs = commandString.trim().split(' ');
      const tool = allArgs[0];
      const args = allArgs.slice(1);

      if (!["gcloud", "gsutil", "kubectl", "bq"].includes(tool)) {
        return `Error: Invalid tool '${tool}'. The first word of the command must be one of gcloud, gsutil, kubectl, or bq.`;
      }

      const userAccessToken = config?.configurable?.userAccessToken;
      const env = { ...process.env };
      
      // ** THE DEFINITIVE FIX V5 - Context Switching **
      // For sign-url, we MUST use the application's default credentials (the service account)
      // and NOT impersonate the user. For all other commands, we impersonate the user.
      const isSignUrlCommand = commandString.includes('gcloud storage sign-url');

      if (userAccessToken && !isSignUrlCommand) {
          console.log('[GCLOUD_TOOL] Impersonation active: Setting CLOUDSDK_AUTH_ACCESS_TOKEN in environment.');
          env['CLOUDSDK_AUTH_ACCESS_TOKEN'] = userAccessToken;
      } else if (isSignUrlCommand) {
          console.log('[GCLOUD_TOOL] Impersonation bypassed: Using application default credentials for sign-url.');
          // By not setting the token, gcloud will fall back to the attached service account.
      }

      // ** THE DEFINITIVE FIX V4 - Comprehensive **
      // Find the project ID from `--project`, `-p`, or `--project_id` flags.
      let projectId = '';
      const projectIndex = args.findIndex(arg => arg === '--project');
      const pIndex = args.findIndex(arg => arg === '-p');
      const bqIndex = args.findIndex(arg => arg.startsWith('--project_id')); // Handles '--project_id=...' and '--project_id ...'

      if (projectIndex !== -1 && projectIndex + 1 < args.length) {
          projectId = args[projectIndex + 1];
          console.log(`[GCLOUD_TOOL] Found --project flag. Using project: ${projectId}`);
      } else if (pIndex !== -1 && pIndex + 1 < args.length) {
          projectId = args[pIndex + 1];
          console.log(`[GCLOUD_TOOL] Found -p flag. Using project: ${projectId}`);
      } else if (bqIndex !== -1) {
          const bqArg = args[bqIndex];
          if (bqArg.includes('=')) {
              projectId = bqArg.split('=')[1];
          } else if (bqIndex + 1 < args.length) {
              projectId = args[bqIndex + 1];
          }
          if(projectId) {
              console.log(`[GCLOUD_TOOL] Found --project_id flag. Using project: ${projectId}`);
          }
      }

      if (projectId) {
          console.log(`[GCLOUD_TOOL] Forcing CLOUDSDK_CORE_PROJECT to: ${projectId}`);
          env['CLOUDSDK_CORE_PROJECT'] = projectId;
      }

      const accessControlResult = accessControl.check(args.join(' '));
      if (accessControlResult.permitted === false) {
        return accessControlResult.message;
      }
    
      // Linter has been removed.
      const cleanArgs = args;
    
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