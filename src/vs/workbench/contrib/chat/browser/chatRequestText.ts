/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatRequestViewModel } from '../common/model/chatViewModel.js';

/**
 * Text that stands for a request wherever its row is described rather than
 * rendered — the timeline, transcript find and screen readers.
 */
export function getChatRequestText(item: IChatRequestViewModel): string {
	return item.messageText;
}
