import {
    type AuthStatus,
    type ContextItem,
    ContextItemSource,
    type ContextItemTree,
    type DefaultContext,
    FeatureFlag,
    REMOTE_REPOSITORY_PROVIDER_URI,
    abortableOperation,
    authStatus,
    clientCapabilities,
    combineLatest,
    contextFiltersProvider,
    debounceTime,
    displayLineRange,
    displayPathBasename,
    distinctUntilChanged,
    expandToLineRange,
    featureFlagProvider,
    fromVSCodeEvent,
    isDotCom,
    isError,
    isWorkspaceInstance,
    openctxController,
    pendingOperation,
    shareReplay,
    startWith,
    switchMap,
} from '@sourcegraph/cody-shared'
import { Observable, map } from 'observable-fns'
import * as vscode from 'vscode'
import { URI } from 'vscode-uri'
import { getSelectionOrFileContext } from '../commands/context/selection'
import { createRepositoryMention } from '../context/openctx/common/get-repository-mentions'
import { remoteReposForAllWorkspaceFolders } from '../repository/remoteRepos'
import { ChatBuilder } from './chat-view/ChatBuilder'
import {
    activeEditorContextForOpenCtxMentions,
    contextItemMentionFromOpenCtxItem,
} from './context/chatContext'

type DefaultContextPolicy = 'full' | 'empty'
let currentDefaultContextPolicy: DefaultContextPolicy = 'full'

export function requestEmptyDefaultContext(): void {
    currentDefaultContextPolicy = 'empty'
}

// Get an empty or default context observable
export function getEmptyOrDefaultContextObservable({
    chatBuilder,
}: {
    chatBuilder: Observable<ChatBuilder>
}): Observable<DefaultContext | typeof pendingOperation> {
    // Capture and reset policy
    const policy = currentDefaultContextPolicy
    if (policy === 'empty') {
        currentDefaultContextPolicy = 'full'
        return Observable.of({ initialContext: [], corpusContext: [] })
    }

    return observeDefaultContext({ chatBuilder }).pipe(shareReplay())
}

/**
 * Observe the initial context that should be populated in the chat message input field.
 */
export function observeDefaultContext({
    chatBuilder,
}: {
    chatBuilder: Observable<ChatBuilder>
}): Observable<DefaultContext | typeof pendingOperation> {
    return combineLatest(
        getCurrentFileOrSelection({ chatBuilder }).pipe(distinctUntilChanged()),
        getCorpusContextItemsForEditorState().pipe(distinctUntilChanged()),
        getOpenCtxContextItems().pipe(distinctUntilChanged()),
        featureFlagProvider.evaluatedFeatureFlag(FeatureFlag.NoDefaultRepoChip)
    ).pipe(
        debounceTime(50),
        map(
            ([currentFileOrSelectionContext, corpusContext, openctxContext, noDefaultRepoChip]):
                | DefaultContext
                | typeof pendingOperation => {
                if (corpusContext === pendingOperation) {
                    return pendingOperation
                }

                const baseInitialContext = [
                    ...(openctxContext === pendingOperation ? [] : openctxContext),
                    ...(currentFileOrSelectionContext === pendingOperation
                        ? []
                        : currentFileOrSelectionContext),
                ]

                // Handle corpus context based on flag
                // When flag is enabled, no corpus items in initialContext
                if (noDefaultRepoChip) {
                    return {
                        initialContext: baseInitialContext,
                        corpusContext,
                    }
                }

                // When flag is disabled, include in initialContext
                const initialCorpusItems = corpusContext.filter(
                    item => item.source === ContextItemSource.Initial
                )
                const remainingCorpusItems = corpusContext.filter(
                    item => item.source !== ContextItemSource.Initial
                )

                return {
                    initialContext: [...baseInitialContext, ...initialCorpusItems],
                    corpusContext: remainingCorpusItems,
                }
            }
        )
    )
}

const activeTextEditor = fromVSCodeEvent(
    vscode.window.onDidChangeActiveTextEditor,
    () => vscode.window.activeTextEditor
).pipe(shareReplay())

function getCurrentFileOrSelection({
    chatBuilder,
}: {
    chatBuilder: Observable<ChatBuilder>
}): Observable<ContextItem[] | typeof pendingOperation> {
    /**
     * If the active text editor changes, this observable immediately emits.
     *
     * If *only* the active selection changes, it debounces 200ms before emitting so we don't spam a
     * bunch of minor updates as the user is actively moving their cursor or changing their
     * selection.
     */
    const selectionOrFileChanged = activeTextEditor.pipe(
        switchMap(() =>
            fromVSCodeEvent(vscode.window.onDidChangeTextEditorSelection).pipe(
                debounceTime(200),
                startWith(undefined),
                map(() => vscode.window.activeTextEditor?.selection)
            )
        )
    )
    const selectionOrFileContext = selectionOrFileChanged.pipe(
        abortableOperation(() => getSelectionOrFileContext())
    )

    return combineLatest(selectionOrFileContext, ChatBuilder.contextWindowForChat(chatBuilder)).pipe(
        switchMap(
            ([selectionOrFileContext, contextWindow]): Observable<
                ContextItem[] | typeof pendingOperation
            > => {
                if (contextWindow === pendingOperation) {
                    return Observable.of(pendingOperation)
                }
                const userContextSize = isError(contextWindow)
                    ? undefined
                    : contextWindow.context?.user ?? contextWindow.input

                const items: ContextItem[] = []

                const contextFile = selectionOrFileContext[0]
                if (contextFile) {
                    // Always add the current file item
                    items.push({
                        ...contextFile,
                        type: 'file',
                        title: 'Current File',
                        description: displayPathBasename(contextFile.uri),
                        range: undefined,
                        isTooLarge:
                            userContextSize !== undefined &&
                            contextFile.size !== undefined &&
                            contextFile.size > userContextSize,
                        source: ContextItemSource.Initial,
                        icon: 'file',
                    })

                    const range = contextFile.range ? expandToLineRange(contextFile.range) : undefined
                    // Add the current selection item if there's a range
                    if (range) {
                        items.push({
                            ...contextFile,
                            type: 'file',
                            title: 'Current Selection',
                            description: `${displayPathBasename(contextFile.uri)}:${displayLineRange(
                                range
                            )}`,
                            range,
                            isTooLarge:
                                userContextSize !== undefined &&
                                contextFile.size !== undefined &&
                                contextFile.size > userContextSize,
                            // NOTE: Do not set source to initial, this is used for
                            // picking the correct prompt template for selection during prompt building.
                            source: ContextItemSource.Selection,
                            icon: 'list-selection',
                        })
                    }
                }
                return Observable.of(items)
            }
        )
    )
}

export function getCorpusContextItemsForEditorState(): Observable<
    ContextItem[] | typeof pendingOperation
> {
    const relevantAuthStatus = authStatus.pipe(
        map(
            authStatus =>
                ({
                    authenticated: authStatus.authenticated,
                    endpoint: authStatus.endpoint,
                    allowRemoteContext: clientCapabilities().isCodyWeb || !isDotCom(authStatus),
                    isDotComUser: isDotCom(authStatus),
                    isEnterpriseStarterUser: isWorkspaceInstance(authStatus),
                    isEnterpriseUser: !isDotCom(authStatus) && !isWorkspaceInstance(authStatus),
                }) satisfies Pick<AuthStatus, 'authenticated' | 'endpoint'> & {
                    allowRemoteContext: boolean
                    isDotComUser: boolean
                    isEnterpriseStarterUser: boolean
                    isEnterpriseUser: boolean
                }
        ),
        distinctUntilChanged()
    )

    return combineLatest(
        relevantAuthStatus,
        remoteReposForAllWorkspaceFolders,
        activeTextEditor,
        featureFlagProvider.evaluatedFeatureFlag(FeatureFlag.SymfRetrievalDisabled)
    ).pipe(
        abortableOperation(
            async (
                [authStatus, remoteReposForAllWorkspaceFolders, activeEditor, symfRetrievalDisabled],
                signal
            ) => {
                const items: ContextItem[] = []

                // Add workspace folders: current one to initial context, others to corpus context
                const workspaceFolders = vscode.workspace.workspaceFolders
                if (workspaceFolders && !symfRetrievalDisabled) {
                    let currentWorkspaceFolder: vscode.WorkspaceFolder | undefined

                    // check also for the first visible editor if no active editor is present
                    // this is happening when we have editor Cody and we receive an undefined activeEditor
                    const activeVisibleEditor: vscode.TextEditor | undefined =
                        activeEditor || vscode.window.visibleTextEditors[0]

                    // If there's an active editor, use its workspace folder (could be undefined if outside workspace)
                    // otherwise use the first workspace folder
                    currentWorkspaceFolder = activeVisibleEditor
                        ? vscode.workspace.getWorkspaceFolder(activeVisibleEditor.document?.uri)
                        : workspaceFolders[0]

                    for (const workspaceFolder of workspaceFolders) {
                        const isCurrentFolder =
                            currentWorkspaceFolder &&
                            workspaceFolder.uri.toString() === currentWorkspaceFolder.uri.toString()

                        items.push({
                            type: 'tree',
                            uri: workspaceFolder.uri,
                            title: isCurrentFolder ? 'Current Repository' : workspaceFolder.name,
                            name: workspaceFolder.name,
                            description: workspaceFolder.name,
                            isWorkspaceRoot: true,
                            content: null,
                            // Current folder goes to initial context (pre-filled), others go to corpus context (@ mention menu)
                            source: isCurrentFolder ? ContextItemSource.Initial : ContextItemSource.User,
                            icon: 'folder',
                        } satisfies ContextItemTree)
                    }
                }

                // TODO(sqs): Make this consistent between self-serve (no remote search) and enterprise (has
                // remote search). There should be a single internal thing in Cody that lets you monitor the
                // user's current codebase.
                if (authStatus.allowRemoteContext) {
                    if (remoteReposForAllWorkspaceFolders === pendingOperation) {
                        return pendingOperation
                    }
                    if (isError(remoteReposForAllWorkspaceFolders)) {
                        throw remoteReposForAllWorkspaceFolders
                    }
                    for (const repo of remoteReposForAllWorkspaceFolders) {
                        if (await contextFiltersProvider.isRepoNameIgnored(repo.name)) {
                            continue
                        }
                        if (repo.id === undefined) {
                            continue
                        }
                        items.push({
                            ...contextItemMentionFromOpenCtxItem(
                                await createRepositoryMention(
                                    {
                                        id: repo.id,
                                        name: repo.name,
                                        url: repo.name,
                                    },
                                    REMOTE_REPOSITORY_PROVIDER_URI,
                                    authStatus
                                )
                            ),
                            title: 'Current Codebase',
                            description: repo.name,
                            source:
                                items.length > 0 ? ContextItemSource.Unified : ContextItemSource.Initial,
                            icon: 'search',
                        })
                    }
                    // CTA to index repositories should only show for Enterprise customers, see CODY-5017 & CODY-4676
                    if (authStatus.isEnterpriseUser && remoteReposForAllWorkspaceFolders.length === 0) {
                        if (!clientCapabilities().isCodyWeb) {
                            items.push({
                                type: 'open-link',
                                title: 'Current Codebase',
                                badge: 'Not yet available',
                                content: null,
                                uri: URI.parse(
                                    'https://sourcegraph.com/docs/cody/prompts-guide#indexing-your-repositories-for-context'
                                ),
                                name: '',
                                icon: 'search',
                            })
                        }
                    }
                }
                return items
            }
        )
    )
}

function getOpenCtxContextItems(): Observable<ContextItem[] | typeof pendingOperation> {
    return openctxController.pipe(
        switchMap(c =>
            c.metaChanges({}, {}).pipe(
                switchMap((providers): Observable<ContextItem[] | typeof pendingOperation> => {
                    const providersWithAutoInclude = providers.filter(meta => meta.mentions?.autoInclude)
                    if (providersWithAutoInclude.length === 0) {
                        return Observable.of([])
                    }

                    return activeTextEditor.pipe(
                        debounceTime(50),
                        switchMap(() => activeEditorContextForOpenCtxMentions),
                        switchMap(activeEditorContext => {
                            if (activeEditorContext === pendingOperation) {
                                return Observable.of(pendingOperation)
                            }
                            if (isError(activeEditorContext)) {
                                return Observable.of([])
                            }
                            return combineLatest(
                                ...providersWithAutoInclude.map(provider =>
                                    c.mentionsChanges(
                                        { ...activeEditorContext, autoInclude: true },
                                        provider
                                    )
                                )
                            ).pipe(
                                map(mentionsResults =>
                                    mentionsResults.flat().map(
                                        mention =>
                                            ({
                                                ...mention,
                                                provider: 'openctx',
                                                type: 'openctx',
                                                uri: URI.parse(mention.uri),
                                                source: ContextItemSource.Initial,
                                                mention, // include the original mention to pass to `items` later
                                            }) satisfies ContextItem
                                    )
                                ),
                                startWith(pendingOperation)
                            )
                        })
                    )
                })
            )
        )
    )
}
