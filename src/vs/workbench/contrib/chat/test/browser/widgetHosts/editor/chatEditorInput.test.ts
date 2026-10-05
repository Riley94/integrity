/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../../base/common/cancellation.js';
import { Event } from '../../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../../../base/common/resources.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { TestInstantiationService } from '../../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../../../platform/workspace/common/workspace.js';
import { ChatEditorInput, ChatEditorInputSerializer } from '../../../../browser/widgetHosts/editor/chatEditorInput.js';
import { IChatEditorOptions } from '../../../../browser/widgetHosts/editor/chatEditor.js';
import { IChatService, IChatSessionStartOptions } from '../../../../common/chatService/chatService.js';
import { IChatSessionsService, localChatSessionType } from '../../../../common/chatSessionsService.js';
import { ChatAgentLocation, SessionTypeSelectionReason } from '../../../../common/constants.js';
import { IChatModel } from '../../../../common/model/chatModel.js';
import { getChatSessionType, LocalChatSessionUri } from '../../../../common/model/chatUri.js';
import { MockChatSessionsService } from '../../../common/mockChatSessionsService.js';
import { TestContextService, TestStorageService } from '../../../../../../test/common/workbenchTestServices.js';

suite('ChatEditorInput', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('explicit local session type starts local session for generic editor URI', async () => {
		const sessionResource = LocalChatSessionUri.forSession('explicit-local');
		const model = {
			onDidDispose: Event.None,
			onDidChange: Event.None,
			sessionResource,
		} as Partial<IChatModel> as IChatModel;

		let startCall: { location: ChatAgentLocation; options: IChatSessionStartOptions | undefined } | undefined;
		let didTryDefaultLoad = false;
		const chatService = {
			startNewLocalSession(location: ChatAgentLocation, options?: IChatSessionStartOptions) {
				startCall = { location, options };
				return { object: model, dispose: () => { } };
			},
			async acquireOrLoadSession() {
				didTryDefaultLoad = true;
				return undefined;
			},
		} as Partial<IChatService> as IChatService;

		const input = new ChatEditorInput(
			ChatEditorInput.getNewEditorUri(),
			{ explicitSessionType: localChatSessionType },
			chatService,
			{} as IDialogService,
			{} as IConfigurationService,
			{} as IChatSessionsService,
			{} as IInstantiationService,
			{} as IStorageService,
			new NullLogService(),
			new TestContextService(),
		);

		try {
			const resolved = await input.resolve();

			assert.deepStrictEqual({
				model: resolved?.model,
				sessionResource: input.sessionResource,
				startLocation: startCall?.location,
				debugOwner: startCall?.options?.debugOwner,
				selectionReason: startCall?.options?.sessionTypeSelectionReason,
				didTryDefaultLoad,
			}, {
				model,
				sessionResource,
				startLocation: ChatAgentLocation.Chat,
				debugOwner: 'ChatEditorInput#resolveExplicitLocal',
				selectionReason: 'explicitOverride',
				didTryDefaultLoad: false,
			});
		} finally {
			input.dispose();
		}
	});

	test('resolved local creation metadata reaches the model and is not serialized', async () => {
		const sessionResource = LocalChatSessionUri.forSession('resolved-local');
		const model = {
			onDidDispose: Event.None,
			onDidChange: Event.None,
			sessionResource,
		} as Partial<IChatModel> as IChatModel;

		let acquiredReason: SessionTypeSelectionReason | undefined;
		let startedReason: SessionTypeSelectionReason | undefined;
		const chatService = {
			async acquireOrLoadSession(_resource: URI, _location: ChatAgentLocation, _token: CancellationToken, _debugOwner?: string, sessionTypeSelectionReason?: SessionTypeSelectionReason) {
				acquiredReason = sessionTypeSelectionReason;
				return undefined;
			},
			startNewLocalSession(_location: ChatAgentLocation, options?: IChatSessionStartOptions) {
				startedReason = options?.sessionTypeSelectionReason;
				return { object: model, dispose: () => { } };
			},
		} as Partial<IChatService> as IChatService;

		const input = new ChatEditorInput(
			sessionResource,
			{ sessionTypeSelectionReason: 'currentSession' },
			chatService,
			{} as IDialogService,
			{} as IConfigurationService,
			{} as IChatSessionsService,
			{} as IInstantiationService,
			{} as IStorageService,
			new NullLogService(),
			new TestContextService(),
		);

		try {
			const resolved = await input.resolve();
			const serialized = new ChatEditorInputSerializer().serialize(input);
			assert.ok(serialized);
			const serializedOptions = (JSON.parse(serialized) as { options: IChatEditorOptions }).options;

			assert.deepStrictEqual({
				model: resolved?.model,
				acquiredReason,
				startedReason,
				serializedOptions,
			}, {
				model,
				acquiredReason: 'currentSession',
				startedReason: 'currentSession',
				serializedOptions: {},
			});
		} finally {
			input.dispose();
		}
	});

	test('explicit local session type preserves empty local session resource', async () => {
		const sessionResource = LocalChatSessionUri.forSession('explicit-empty-local');
		const model = {
			hasRequests: false,
			onDidDispose: Event.None,
			onDidChange: Event.None,
			sessionResource,
		} as Partial<IChatModel> as IChatModel;

		const loadedResources: string[] = [];
		const chatService = {
			async acquireOrLoadSession(resource: URI) {
				loadedResources.push(resource.toString());
				return { object: model, dispose: () => { } };
			},
			startNewLocalSession() {
				throw new Error('Should not create a new local session when the local session resource resolves');
			},
		} as Partial<IChatService> as IChatService;

		const input = new ChatEditorInput(
			sessionResource,
			{ explicitSessionType: localChatSessionType },
			chatService,
			{} as IDialogService,
			{} as IConfigurationService,
			{} as IChatSessionsService,
			{} as IInstantiationService,
			{} as IStorageService,
			new NullLogService(),
			new TestContextService(),
		);

		try {
			const resolved = await input.resolve();

			assert.deepStrictEqual({
				model: resolved?.model,
				sessionResource: input.sessionResource,
				loadedResources,
			}, {
				model,
				sessionResource,
				loadedResources: [sessionResource.toString()],
			});
		} finally {
			input.dispose();
		}
	});

	function createInputForCopy(store: DisposableStore, resource: URI): ChatEditorInput {
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IChatService, {});
		instantiationService.stub(IDialogService, {});
		instantiationService.set(IConfigurationService, new TestConfigurationService());
		instantiationService.set(IChatSessionsService, new MockChatSessionsService());
		instantiationService.set(IStorageService, store.add(new TestStorageService()));
		instantiationService.set(ILogService, new NullLogService());
		instantiationService.set(IWorkspaceContextService, new TestContextService());
		return store.add(instantiationService.createInstance(ChatEditorInput, resource, {}));
	}

	test('copy preserves a local session type as a new local session', () => {
		const store = disposables.add(new DisposableStore());
		const source = LocalChatSessionUri.getNewSessionUri();
		const input = createInputForCopy(store, source);

		const copied = store.add(input.copy() as ChatEditorInput);

		assert.deepStrictEqual({
			copiedType: getChatSessionType(copied.resource),
			copiedScheme: copied.resource.scheme,
			distinctFromSource: !isEqual(copied.resource, source),
		}, {
			copiedType: localChatSessionType,
			copiedScheme: LocalChatSessionUri.scheme,
			distinctFromSource: true,
		});
	});
});
