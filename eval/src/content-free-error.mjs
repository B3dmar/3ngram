// SPDX-License-Identifier: Apache-2.0
// An error whose message the code wrote itself and that holds no dataset
// text, prompt or model answer (hard rule 6). The QA CLI prints only these;
// any other error's message may quote content (JSON.parse does) and is withheld.
export class ContentFreeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ContentFreeError'
  }
}
