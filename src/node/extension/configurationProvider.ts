/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { join, isAbsolute, dirname } from 'path';
import * as fs from 'fs';

import { writeToConsole } from './utilities';
import { detectDebugType, detectProtocolForPid, INSPECTOR_PORT_DEFAULT, LEGACY_PORT_DEFAULT } from './protocolDetection';
import { pickProcess } from './processPicker';
import { prepareAutoAttachChildProcesses } from './childProcesses';

const localize = nls.loadMessageBundle();

//---- NodeConfigurationProvider

export class NodeConfigurationProvider implements vscode.DebugConfigurationProvider {

	constructor(
		private _extensionContext: vscode.ExtensionContext
	) { }

	/**
	 * Returns an initial debug configuration based on contextual information, e.g. package.json or folder.
	 */
	provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration[]> {

		return [ createLaunchConfigFromContext(folder, false) ];
	}

	/**
	 * Try to add all missing attributes to the debug configuration being launched.
	 */
	resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {

			config = createLaunchConfigFromContext(folder, true, config);

			if (!config.program) {
				const message = localize('program.not.found.message', "Cannot find a program to debug");
				return vscode.window.showErrorMessage(message, { modal: true }).then(_ => {
					return undefined;	// abort launch
				});
			}
		}

		// make sure that config has a 'cwd' attribute set
		if (!config.cwd) {
			if (folder) {
				config.cwd = folder.uri.fsPath;
			}

			// no folder -> config is a user or workspace launch config
			if (!config.cwd && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
				config.cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;
			}

			// no folder case
			if (!config.cwd && config.program === '${file}') {
				config.cwd = '${fileDirname}';
			}

			// program is some absolute path
			if (!config.cwd && isAbsolute(config.program)) {
				// derive 'cwd' from 'program'
				config.cwd = dirname(config.program);
			}

			// last resort
			if (!config.cwd) {
				config.cwd = '${workspaceFolder}';
			}
		}

		// remove 'useWSL' on all platforms but Windows
		if (process.platform !== 'win32' && config.useWSL) {
			this._extensionContext.logger.debug('useWSL attribute ignored on non-Windows OS.');
			delete config.useWSL;
		}

		// when using "integratedTerminal" ensure that debug console doesn't get activated; see #43164
		if (config.console === 'integratedTerminal' && !config.internalConsoleOptions) {
			config.internalConsoleOptions = 'neverOpen';
		}

		// "nvm" support
		if (config.runtimeVersion && config.runtimeVersion !== 'default') {

			// if a runtime version is specified we prepend env.PATH with the folder that corresponds to the version

			let bin: string | undefined = undefined;
			let versionManagerName: string | undefined = undefined;

			// first try the Node Version Switcher 'nvs'
			let nvsHome = process.env['NVS_HOME'];
			if (!nvsHome) {
				// NVS_HOME is not always set. Probe for 'nvs' directory instead
				const nvsDir = process.platform === 'win32' ? join(process.env['LOCALAPPDATA'], 'nvs') : join(process.env['HOME'], '.nvs');
				if (fs.existsSync(nvsDir)) {
					nvsHome = nvsDir;
				}
			}

			const { nvsFormat, remoteName, semanticVersion, arch } = parseVersionString(config.runtimeVersion);

			if (nvsFormat || nvsHome) {
				if (nvsHome) {
					bin = join(nvsHome, remoteName, semanticVersion, arch);
					if (process.platform !== 'win32') {
						bin = join(bin, 'bin');
					}
					versionManagerName = 'nvs';
				} else {
					return vscode.window.showErrorMessage(localize('NVS_HOME.not.found.message', "Attribute 'runtimeVersion' requires Node.js version manager 'nvs'."), { modal: true }).then(_ => {
						return undefined;	// abort launch
					});
				}
			}

			if (!bin) {

				// now try the Node Version Manager 'nvm'
				if (process.platform === 'win32') {
					const nvmHome = process.env['NVM_HOME'];
					if (!nvmHome) {
						return vscode.window.showErrorMessage(localize('NVM_HOME.not.found.message', "Attribute 'runtimeVersion' requires Node.js version manager 'nvm-windows' or 'nvs'."), { modal: true }).then(_ => {
							return undefined;	// abort launch
						});
					}
					bin = join(nvmHome, `v${config.runtimeVersion}`);
					versionManagerName = 'nvm-windows';
				} else {	// macOS and linux
					let nvmHome = process.env['NVM_DIR'];
					if (!nvmHome) {
						// if NVM_DIR is not set. Probe for '.nvm' directory instead
						const nvmDir = join(process.env['HOME'], '.nvm');
						if (fs.existsSync(nvmDir)) {
							nvmHome = nvmDir;
						}
					}
					if (!nvmHome) {
						return vscode.window.showErrorMessage(localize('NVM_DIR.not.found.message', "Attribute 'runtimeVersion' requires Node.js version manager 'nvm' or 'nvs'."), { modal: true }).then(_ => {
							return undefined;	// abort launch
						});
					}
					bin = join(nvmHome, 'versions', 'node', `v${config.runtimeVersion}`, 'bin');
					versionManagerName = 'nvm';
				}
			}

			if (fs.existsSync(bin)) {
				if (!config.env) {
					config.env = {};
				}
				if (process.platform === 'win32') {
					config.env['Path'] = `${bin};${process.env['Path']}`;
				} else {
					config.env['PATH'] = `${bin}:${process.env['PATH']}`;
				}
			} else {
				return vscode.window.showErrorMessage(localize('runtime.version.not.found.message', "Node.js version '{0}' not installed for '{1}'.", config.runtimeVersion, versionManagerName), { modal: true }).then(_ => {
					return undefined;	// abort launch
				});
			}
		}

		// is "auto attach child process" mode enabled?
		if (config.autoAttachChildProcesses) {
			prepareAutoAttachChildProcesses(folder, config);
		}

		// determine which protocol to use
		return determineDebugType(config, this._extensionContext.logger).then(debugType => {

			if (debugType) {
				config.type = debugType;
			}

			return this.fixupLogParameters(config);
		});
	}

	private async fixupLogParameters(config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration> {
		if (config.trace && !config.logFilePath) {
			const fileName = config.type === 'node' ?
				'debugadapter-legacy.txt' :
				'debugadapter.txt';

			config.logFilePath = join(await this._extensionContext.logger.logDirectory, fileName);
		}

		return config;
	}
}

//---- helpers ----------------------------------------------------------------------------------------------------------------

function createLaunchConfigFromContext(folder: vscode.WorkspaceFolder | undefined, resolve: boolean, existingConfig?: vscode.DebugConfiguration): vscode.DebugConfiguration {

	const config = {
		type: 'node',
		request: 'launch',
		name: localize('node.launch.config.name', "Launch Program")
	};

	if (existingConfig && existingConfig.noDebug) {
		config['noDebug'] = true;
	}

	const pkg = loadJSON(folder, 'package.json');
	if (pkg && pkg.name === 'mern-starter') {

		if (resolve) {
			writeToConsole(localize({ key: 'mern.starter.explanation', comment: ['argument contains product name without translation'] }, "Launch configuration for '{0}' project created.", 'Mern Starter'));
		}
		configureMern(config);

	} else {
		let program: string | undefined;
		let useSourceMaps = false;

		if (pkg) {
			// try to find a value for 'program' by analysing package.json
			program = guessProgramFromPackage(folder, pkg, resolve);
			if (program && resolve) {
				writeToConsole(localize('program.guessed.from.package.json.explanation', "Launch configuration created based on 'package.json'."));
			}
		}

		if (!program) {
			// try to use file open in editor
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const languageId = editor.document.languageId;
				if (languageId === 'javascript' || isTranspiledLanguage(languageId)) {
					const wf = vscode.workspace.getWorkspaceFolder(editor.document.uri);
					if (wf === folder) {
						program = vscode.workspace.asRelativePath(editor.document.uri);
						if (!isAbsolute(program)) {
							program = '${workspaceFolder}/' + program;
						}
					}
				}
				useSourceMaps = isTranspiledLanguage(languageId);
			}
		}

		// if we couldn't find a value for 'program', we just let the launch config use the file open in the editor
		if (!resolve && !program) {
			program = '${file}';
		}

		if (program) {
			config['program'] = program;
		}

		// prepare for source maps by adding 'outFiles' if typescript or coffeescript is detected
		if (useSourceMaps || vscode.workspace.textDocuments.some(document => isTranspiledLanguage(document.languageId))) {
			if (resolve) {
				writeToConsole(localize('outFiles.explanation', "Adjust glob pattern(s) in the 'outFiles' attribute so that they cover the generated JavaScript."));
			}

			let dir = '';
			const tsConfig = loadJSON(folder, 'tsconfig.json');
			if (tsConfig && tsConfig.compilerOptions && tsConfig.compilerOptions.outDir) {
				const outDir = <string> tsConfig.compilerOptions.outDir;
				if (!isAbsolute(outDir)) {
					dir = outDir;
					if (dir.indexOf('./') === 0) {
						dir = dir.substr(2);
					}
					if (dir[dir.length-1] !== '/') {
						dir += '/';
					}
				}
				config['preLaunchTask'] = 'tsc: build - tsconfig.json';
			}
			config['outFiles'] = ['${workspaceFolder}/' + dir + '**/*.js'];
		}
	}

	return config;
}

function loadJSON(folder: vscode.WorkspaceFolder | undefined, file: string): any {
	if (folder) {
		try {
			const path = join(folder.uri.fsPath, file);
			const content = fs.readFileSync(path, 'utf8');
			return JSON.parse(content);
		} catch (error) {
			// silently ignore
		}
	}
	return undefined;
}

function configureMern(config: any) {
	config.protocol = 'inspector';
	config.runtimeExecutable = 'nodemon';
	config.program = '${workspaceFolder}/index.js';
	config.restart = true;
	config.env = {
		BABEL_DISABLE_CACHE: '1',
		NODE_ENV: 'development'
	};
	config.console = 'integratedTerminal';
	config.internalConsoleOptions = 'neverOpen';
}

function isTranspiledLanguage(languagId: string) : boolean {
	return languagId === 'typescript' || languagId === 'coffeescript';
}

/*
 * try to find the entry point ('main') from the package.json
 */
function guessProgramFromPackage(folder: vscode.WorkspaceFolder | undefined, packageJson: any, resolve: boolean): string | undefined {

	let program: string | undefined;

	try {
		if (packageJson.main) {
			program = packageJson.main;
		} else if (packageJson.scripts && typeof packageJson.scripts.start === 'string') {
			// assume a start script of the form 'node server.js'
			program = (<string>packageJson.scripts.start).split(' ').pop();
		}

		if (program) {
			let path: string | undefined;
			if (isAbsolute(program)) {
				path = program;
			} else {
				path = folder ? join(folder.uri.fsPath, program) : undefined;
				program = join('${workspaceFolder}', program);
			}
			if (resolve && path && !fs.existsSync(path) && !fs.existsSync(path + '.js')) {
				return undefined;
			}
		}

	} catch (error) {
		// silently ignore
	}

	return program;
}

//---- debug type -------------------------------------------------------------------------------------------------------------

function determineDebugType(config: any, logger: vscode.Logger): Promise<string | null> {
	if (config.request === 'attach' && typeof config.processId === 'string') {
		return determineDebugTypeForPidConfig(config);
	} else if (config.protocol === 'legacy') {
		return Promise.resolve('node');
	} else if (config.protocol === 'inspector') {
		return Promise.resolve('node2');
	} else {
		// 'auto', or unspecified
		return detectDebugType(config, logger);
	}
}

function determineDebugTypeForPidConfig(config: any): Promise<string | null> {
	const getPidP = isPickProcessCommand(config.processId) ?
		pickProcess() :
		Promise.resolve(config.processId);

	return getPidP.then(pid => {
		if (pid && pid.match(/^[0-9]+$/)) {
			const pidNum = Number(pid);
			putPidInDebugMode(pidNum);

			return determineDebugTypeForPidInDebugMode(config, pidNum);
		} else {
			throw new Error(localize('VSND2006', "Attach to process: '{0}' doesn't look like a process id.", pid));
		}
	}).then(debugType => {
		if (debugType) {
			// processID is handled, so turn this config into a normal port attach config
			config.processId = undefined;
			config.port = debugType === 'node2' ? INSPECTOR_PORT_DEFAULT : LEGACY_PORT_DEFAULT;
		}

		return debugType;
	});
}

function isPickProcessCommand(configProcessId: string): boolean {
	configProcessId = configProcessId.trim();
	return configProcessId === '${command:PickProcess}' || configProcessId === '${command:extension.pickNodeProcess}';
}

function putPidInDebugMode(pid: number): void {
	try {
		if (process.platform === 'win32') {
			// regular node has an undocumented API function for forcing another node process into debug mode.
			// 		(<any>process)._debugProcess(pid);
			// But since we are running on Electron's node, process._debugProcess doesn't work (for unknown reasons).
			// So we use a regular node instead:
			const command = `node -e process._debugProcess(${pid})`;
			execSync(command);
		} else {
			process.kill(pid, 'SIGUSR1');
		}
	} catch (e) {
		throw new Error(localize('VSND2021', "Attach to process: cannot enable debug mode for process '{0}' ({1}).", pid, e));
	}
}

function determineDebugTypeForPidInDebugMode(config: any, pid: number): Promise<string | null> {
	let debugProtocolP: Promise<string | null>;
	if (config.port === INSPECTOR_PORT_DEFAULT) {
		debugProtocolP = Promise.resolve('inspector');
	} else if (config.port === LEGACY_PORT_DEFAULT) {
		debugProtocolP = Promise.resolve('legacy');
	} else if (config.protocol) {
		debugProtocolP = Promise.resolve(config.protocol);
	} else {
		debugProtocolP = detectProtocolForPid(pid);
	}

	return debugProtocolP.then(debugProtocol => {
		return debugProtocol === 'inspector' ? 'node2' :
			debugProtocol === 'legacy' ? 'node' :
				null;
	});
}

function nvsStandardArchName(arch) {
	switch (arch) {
		case '32':
		case 'x86':
		case 'ia32':
			return 'x86';
		case '64':
		case 'x64':
		case 'amd64':
			return 'x64';
		case 'arm':
			const arm_version = (process.config.variables as any).arm_version;
			return arm_version ? 'armv' + arm_version + 'l' : 'arm';
		default:
			return arch;
	}
}

/**
 * Parses a node version string into remote name, semantic version, and architecture
 * components. Infers some unspecified components based on configuration.
 */
function parseVersionString(versionString) {
	const versionRegex = /^(([\w-]+)\/)?(v?(\d+(\.\d+(\.\d+)?)?))(\/((x86)|(32)|((x)?64)|(arm\w*)|(ppc\w*)))?$/i;

	const match = versionRegex.exec(versionString);
	if (!match) {
		throw new Error('Invalid version string: ' + versionString);
	}

	const nvsFormat = !!(match[2] || match[8]);
	const remoteName = match[2] || 'node';
	const semanticVersion = match[4] || '';
	const arch = nvsStandardArchName(match[8] || process.arch);

	return { nvsFormat, remoteName, semanticVersion, arch };
}
