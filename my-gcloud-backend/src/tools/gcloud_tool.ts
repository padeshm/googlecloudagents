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

let lastKnownProjectId = ''; // Add stateful variable for project ID

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
      // BUILD_MARKER: V23 - The architecturally correct fix.
      console.log(`[GCLOUD_TOOL_LOG] Raw command string from agent: "${commandString}"`);

      let tool: string;
      let args: string[];

      if (commandString.startsWith('bq query')) {
        console.log('[GCLOUD_TOOL] bq query detected. Using smart parser for SQL.');
        const sqlQueryIndex = commandString.indexOf("'");
        if (sqlQueryIndex === -1) {
          [tool, ...args] = commandString.trim().split(' ');
        } else {
          const preQueryString = commandString.substring(0, sqlQueryIndex).trim();
          const sqlQuery = commandString.substring(sqlQueryIndex);
          const preQueryArgs = preQueryString.split(' ').filter(arg => arg.length > 0);
          tool = preQueryArgs[0];
          args = [...preQueryArgs.slice(1), sqlQuery];
        }
      } else {
        console.log('[GCLOUD_TOOL] Using robust, shell-disabled parser.');
        const argRegex = /(?:[^\s"\']+|\"[^\"]*\"|\'[^\']*\')+/g;
        let newArgs = commandString.match(argRegex) || [];
        newArgs = newArgs.map(arg => arg.replace(/^['\"]|['\"]$/g, ''));
        [tool, ...args] = newArgs;
      }

      if (!["gcloud", "gsutil", "kubectl", "bq"].includes(tool)) {
        return `Error: Invalid tool '${tool}'. The first word of the command must be one of gcloud, gsutil, kubectl, or bq.`;
      }

      const userAccessToken = config?.configurable?.userAccessToken;
      const env = { ...process.env };
      
      const isSignUrlCommand = commandString.includes('gcloud storage sign-url');

      if (isSignUrlCommand) {
        console.log('[GCLOUD_TOOL] Impersonation bypassed for sign-url. Using application default credentials.');
      } 
      else if (userAccessToken) {
        console.log('[GCLOUD_TOOL] Impersonation active: Setting CLOUDSDK_AUTH_ACCESS_TOKEN in environment.');
        env['CLOUDSDK_AUTH_ACCESS_TOKEN'] = userAccessToken;
      }

      let projectId = '';
      const projectArg = args.find(arg => arg.startsWith('--project'));
      const bqProjectArg = args.find(arg => arg.startsWith('--project_id'));

      if (projectArg) {
          if (projectArg.includes('=')) {
              projectId = projectArg.split('=')[1];
          } else {
              const projectIndex = args.indexOf(projectArg);
              if (projectIndex !== -1 && projectIndex + 1 < args.length) {
                  projectId = args[projectIndex + 1];
              }
          }
      } else if (bqProjectArg) {
          if (bqProjectArg.includes('=')) {
              projectId = bqProjectArg.split('=')[1];
          } else {
            const projectIndex = args.indexOf(bqProjectArg);
              if (projectIndex !== -1 && projectIndex + 1 < args.length) {
                  projectId = args[projectIndex + 1];
              }
          }
      }

      if (projectId) {
        console.log(`[GCLOUD_TOOL] Forcing CLOUDSDK_CORE_PROJECT to: ${projectId}`);
        env['CLOUDSDK_CORE_PROJECT'] = projectId;
        lastKnownProjectId = projectId;
      } else if (lastKnownProjectId) {
        console.log(`[GCLOUD_TOOL] No project flag in command, using last known project: ${lastKnownProjectId}`);
        env['CLOUDSDK_CORE_PROJECT'] = lastKnownProjectId;
      }

      const accessControlResult = accessControl.check(args.join(' '));
      if (accessControlResult.permitted === false) {
        return accessControlResult.message;
      }
    
      const command = {
        tool: tool,
        args: args,
      };
    
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';

        const child = child_process.spawn(command.tool, command.args, { env, shell: false });
    
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
    
        child.on('close', (code) => {
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] Command: '${command.tool} ${command.args.join(' ')}'`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] Exit Code: ${code}`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] STDOUT: ${stdout}`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] STDERR: ${stderr}`);

          if (code === 0) {
            if (isSignUrlCommand) {
                const urlMatch = stdout.match(/^signed_url:\s*(https:\/\/.*)/m);
                if (urlMatch && urlMatch[1]) {
                    console.log(`[GCLOUD_TOOL] Extracted signed URL. Returning only the URL.`);
                    resolve(urlMatch[1].trim());
                } else {
                    resolve('Command executed successfully, but failed to extract the signed URL from the output.');
                }
            } else if (stdout.trim() === '') {
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