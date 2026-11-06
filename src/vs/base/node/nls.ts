/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from '../common/path.js';
import { promises } from 'fs';
import { createHash } from 'crypto';
import { mark } from '../common/performance.js';
import { ILanguagePack, ILanguagePacks, INLSConfiguration } from '../../nls.js';
import { Promises } from './pfs.js';

const bundledChineseFolder = 'studio-language-pack-zh-cn';
type TranslationBundle = { contents: Record<string, Record<string, string>> };

export interface IResolveNLSConfigurationContext {

	/**
	 * Location where `nls.messages.json` and `nls.keys.json` are stored.
	 */
	readonly nlsMetadataPath: string;

	/**
	 * Path to the user data directory. Used as a cache for
	 * language packs converted to the format we need.
	 */
	readonly userDataPath: string;

	/**
	 * Commit of the running application. Can be `undefined`
	 * when not built.
	 */
	readonly commit: string | undefined;

	/**
	 * Locale as defined in `argv.json` or `app.getLocale()`.
	 */
	readonly userLocale: string;

	/**
	 * Locale as defined by the OS (e.g. `app.getPreferredSystemLanguages()`).
	 */
	readonly osLocale: string;
}

export async function resolveNLSConfiguration({ userLocale, osLocale, userDataPath, commit, nlsMetadataPath }: IResolveNLSConfigurationContext): Promise<INLSConfiguration> {
	mark('code/willGenerateNls');

	const dev = Boolean(process.env['VSCODE_DEV'] || !commit);
	if (
		(dev && userLocale !== 'zh-cn') ||
		userLocale === 'pseudo' ||
		userLocale.startsWith('en') ||
		!userDataPath
	) {
		return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
	}

	try {
		const languagePacks = await getLanguagePackConfigurations(userDataPath) ?? {};
		const extensionsPath = join(nlsMetadataPath, '..', 'extensions');
		const installedChinese = languagePacks['zh-cn']?.translations?.vscode;
		if (userLocale === 'zh-cn' && (dev || !installedChinese || !(await Promises.exists(installedChinese)))) {
			languagePacks['zh-cn'] = await getBundledChineseLanguagePack(extensionsPath);
		}

		const resolvedLanguage = resolveLanguagePackLanguage(languagePacks, userLocale);
		if (!resolvedLanguage) {
			return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
		}

		const languagePack = languagePacks[resolvedLanguage];
		const mainLanguagePackPath = languagePack?.translations?.['vscode'];
		if (
			!languagePack ||
			typeof languagePack.hash !== 'string' ||
			!languagePack.translations ||
			typeof mainLanguagePackPath !== 'string' ||
			!(await Promises.exists(mainLanguagePackPath))
		) {
			return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
		}

		const languagePackId = `${languagePack.hash}.${resolvedLanguage}`;
		const globalLanguagePackCachePath = join(userDataPath, 'clp', languagePackId);
		const commitLanguagePackCachePath = join(globalLanguagePackCachePath, commit ?? 'dev');
		const languagePackMessagesFile = dev ? join(nlsMetadataPath, 'nls.dev.zh-cn.json') : join(commitLanguagePackCachePath, 'nls.messages.json');
		const translationsConfigFile = join(globalLanguagePackCachePath, 'tcf.json');
		const languagePackCorruptMarkerFile = join(globalLanguagePackCachePath, 'corrupted.info');

		if (await Promises.exists(languagePackCorruptMarkerFile)) {
			await promises.rm(globalLanguagePackCachePath, { recursive: true, force: true, maxRetries: 3 }); // delete corrupted cache folder
		}

		const result: INLSConfiguration = {
			userLocale,
			osLocale,
			resolvedLanguage,
			defaultMessagesFile: join(nlsMetadataPath, 'nls.messages.json'),
			languagePack: {
				translationsConfigFile,
				messagesFile: languagePackMessagesFile,
				corruptMarkerFile: languagePackCorruptMarkerFile
			},

			// NLS: below properties are a relic from old times only used by vscode-nls and deprecated
			locale: userLocale,
			availableLanguages: { '*': resolvedLanguage },
			_languagePackId: languagePackId,
			_languagePackSupport: true,
			_translationsConfigFile: translationsConfigFile,
			_cacheRoot: globalLanguagePackCachePath,
			_resolvedLanguagePackCoreLocation: commitLanguagePackCachePath,
			_corruptedFile: languagePackCorruptMarkerFile
		};

		if (dev) {
			if (!(await Promises.exists(languagePackMessagesFile))) {
				return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
			}
			await promises.mkdir(globalLanguagePackCachePath, { recursive: true });
			await Promises.writeFile(translationsConfigFile, JSON.stringify(languagePack.translations));
			mark('code/didGenerateNls');
			return result;
		}

		if (await Promises.exists(languagePackMessagesFile) && await Promises.exists(translationsConfigFile)) {
			touch(commitLanguagePackCachePath).catch(() => { }); // We don't wait for this. No big harm if we can't touch
			mark('code/didGenerateNls');
			return result;
		}

		const [
			nlsDefaultKeys,
			nlsDefaultMessages,
			nlsPackdata,
			supplement
		]:
			[Array<[string, string[]]>, string[], TranslationBundle, TranslationBundle | undefined]
			//      ^moduleId ^nlsKeys                               ^moduleId      ^nlsKey ^nlsValue
			= await Promise.all([
				promises.readFile(join(nlsMetadataPath, 'nls.keys.json'), 'utf-8').then(content => JSON.parse(content)),
				promises.readFile(join(nlsMetadataPath, 'nls.messages.json'), 'utf-8').then(content => JSON.parse(content)),
				promises.readFile(mainLanguagePackPath, 'utf-8').then(content => JSON.parse(content)),
				resolvedLanguage === 'zh-cn' ? readBundledChineseSupplement(extensionsPath) : undefined
			]);

		const nlsResult: string[] = [];

		// We expect NLS messages to be in a flat array in sorted order as they
		// where produced during build time. We use `nls.keys.json` to know the
		// right order and then lookup the related message from the translation.
		// If a translation does not exist, we fallback to the default message.

		let nlsIndex = 0;
		for (const [moduleId, nlsKeys] of nlsDefaultKeys) {
			const moduleTranslations = nlsPackdata.contents[moduleId];
			for (const nlsKey of nlsKeys) {
				nlsResult.push(supplement?.contents[moduleId]?.[nlsKey] ?? moduleTranslations?.[nlsKey] ?? nlsDefaultMessages[nlsIndex]);
				nlsIndex++;
			}
		}

		await promises.mkdir(commitLanguagePackCachePath, { recursive: true });

		await Promise.all([
			promises.writeFile(languagePackMessagesFile, JSON.stringify(nlsResult), 'utf-8'),
			promises.writeFile(translationsConfigFile, JSON.stringify(languagePack.translations), 'utf-8')
		]);

		mark('code/didGenerateNls');

		return result;
	} catch (error) {
		console.error('Generating translation files failed.', error);
	}

	return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
}

async function readBundledChineseSupplement(extensionsPath: string): Promise<TranslationBundle | undefined> {
	const supplement = join(extensionsPath, bundledChineseFolder, 'translations', 'studio.i18n.json');
	if (await Promises.exists(supplement)) {
		return JSON.parse(await promises.readFile(supplement, 'utf8'));
	}
	return undefined;
}

/** The bundled pack is available before the extension service or gallery starts. */
export async function getBundledChineseLanguagePack(extensionsPath: string): Promise<ILanguagePack | undefined> {
	const root = join(extensionsPath, bundledChineseFolder);
	try {
		const manifest: {
			publisher: string; name: string; version: string; upstreamCommit: string;
			contributes: { localizations: { localizedLanguageName: string; translations: { id: string; path: string }[] }[] };
		} = JSON.parse(await promises.readFile(join(root, 'package.json'), 'utf8'));
		const localization = manifest.contributes.localizations[0];
		return {
			hash: createHash('sha256').update(manifest.upstreamCommit).update(root).digest('hex'),
			label: localization.localizedLanguageName,
			extensions: [{ extensionIdentifier: { id: manifest.publisher + '.' + manifest.name }, version: manifest.version }],
			translations: Object.fromEntries(localization.translations.map(({ id, path }) => [id, join(root, path)]))
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			console.error('Failed to read the built-in Simplified Chinese pack.', error);
		}
		return undefined;
	}
}

/**
 * The `languagepacks.json` file is a JSON file that contains all metadata
 * about installed language extensions per language. Specifically, for
 * core (`vscode`) and all extensions it supports, it points to the related
 * translation files.
 *
 * The file is updated whenever a new language pack is installed or removed.
 */
async function getLanguagePackConfigurations(userDataPath: string): Promise<ILanguagePacks | undefined> {
	const configFile = join(userDataPath, 'languagepacks.json');
	try {
		return JSON.parse(await promises.readFile(configFile, 'utf-8'));
	} catch (err) {
		return undefined; // Do nothing. If we can't read the file we have no language pack config.
	}
}

function resolveLanguagePackLanguage(languagePacks: ILanguagePacks, locale: string | undefined): string | undefined {
	try {
		while (locale) {
			if (languagePacks[locale]) {
				return locale;
			}

			const index = locale.lastIndexOf('-');
			if (index > 0) {
				locale = locale.substring(0, index);
			} else {
				return undefined;
			}
		}
	} catch (error) {
		console.error('Resolving language pack configuration failed.', error);
	}

	return undefined;
}

function defaultNLSConfiguration(userLocale: string, osLocale: string, nlsMetadataPath: string): INLSConfiguration {
	mark('code/didGenerateNls');

	return {
		userLocale,
		osLocale,
		resolvedLanguage: 'en',
		defaultMessagesFile: join(nlsMetadataPath, 'nls.messages.json'),

		// NLS: below 2 are a relic from old times only used by vscode-nls and deprecated
		locale: userLocale,
		availableLanguages: {}
	};
}

//#region fs helpers

function touch(path: string): Promise<void> {
	const date = new Date();

	return promises.utimes(path, date, date);
}

//#endregion
