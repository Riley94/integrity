/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getChatRequestText } from '../../browser/chatRequestText.js';
import { IChatRequestViewModel } from '../../common/model/chatViewModel.js';

function request(messageText: string): IChatRequestViewModel {
	return { id: 'r', messageText } as unknown as IChatRequestViewModel;
}

suite('getChatRequestText', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('names a request by its own text', () => {
		assert.strictEqual(getChatRequestText(request('Rename the widget')), 'Rename the widget');
	});
});
