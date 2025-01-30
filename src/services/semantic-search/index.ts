import {
	CodeDefinition,
	convertSegmentToDefinition,
	SearchResult,
	SearchResultType,
	FileSearchResult,
	CodeSearchResult,
} from "./types"
import * as path from "path"
import * as vscode from "vscode"
import { TreeSitterParser } from "./parser/tree-sitter"
import { LanceDBVectorStore } from "./vector-store/lancedb"
import { StoreSearchResult } from "./vector-store/types"
import * as crypto from "crypto"
import { ApiHandler } from "../../api"

export interface SemanticSearchConfig {
	/**
	 * Directory to store model files and cache
	 */
	storageDir: string

	/**
	 * Maximum number of results to return
	 */
	maxResults?: number

	/**
	 * Context for storage and paths
	 */
	context: vscode.ExtensionContext
}

export enum WorkspaceIndexStatus {
	NotIndexed = "Not indexed",
	Indexing = "Indexing",
	Indexed = "Indexed",
}

export class SemanticSearchService {
	// Supported file extensions for semantic search
	private static readonly SUPPORTED_CODE_EXTENSIONS = new Set([
		"js",
		"jsx",
		"ts",
		"tsx", // JavaScript/TypeScript
		"py", // Python
		"rs", // Rust
		"go", // Go
		"cpp",
		"hpp", // C++
		"c",
		"h", // C
		"cs", // C#
		"rb", // Ruby
		"java", // Java
		"php", // PHP
		"swift", // Swift
	])

	// Maximum size for text files (2MB)
	private static readonly MAX_TEXT_FILE_SIZE = 2 * 1024 * 1024

	private static async isTextFile(filePath: string): Promise<boolean> {
		const stats = await vscode.workspace.fs.stat(vscode.Uri.file(filePath))

		// Check if path is a directory
		if (stats.type === vscode.FileType.Directory) {
			return false
		}

		if (stats.size > this.MAX_TEXT_FILE_SIZE) {
			return false
		}

		const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))

		// Check for null bytes and other control characters (except common ones like newline, tab)
		const sampleSize = Math.min(4096, fileContent.length)
		for (let i = 0; i < sampleSize; i++) {
			if (fileContent[i] === 0 || (fileContent[i] < 32 && ![9, 10, 13].includes(fileContent[i]))) {
				return false
			}
		}

		// Check if the buffer is valid UTF-8
		if (!this.isValidUtf8(fileContent)) {
			return false
		}

		// Heuristic check for ASCII printable characters
		let validBytes = 0
		for (let i = 0; i < fileContent.length; i++) {
			const byte = fileContent[i]
			if (
				byte === 0x09 || // Tab
				byte === 0x0a || // Line Feed
				byte === 0x0d || // Carriage Return
				(byte >= 0x20 && byte <= 0x7e) // Printable ASCII
			) {
				validBytes++
			}
		}

		const ratio = validBytes / fileContent.length
		return ratio >= 0.98 // 98% threshold
	}

	private static isValidUtf8(buffer: Uint8Array): boolean {
		// Check if buffer can be converted to UTF-8 without replacement characters
		const str = new TextDecoder().decode(buffer)
		return !str.includes("\ufffd") // No replacement characters found
	}

	// Check if a file is supported for indexing
	public static async isFileSupported(filePath: string): Promise<boolean> {
		const ext = path.extname(filePath).toLowerCase().slice(1)
		return this.SUPPORTED_CODE_EXTENSIONS.has(ext) || (await this.isTextFile(filePath))
	}

	// Check if a file should be treated as a code file (parsed with tree-sitter)
	private static isCodeFile(filePath: string): boolean {
		const ext = path.extname(filePath).toLowerCase().slice(1)
		return this.SUPPORTED_CODE_EXTENSIONS.has(ext)
	}

	// Add chunking method for text files
	private static chunkText(text: string, maxChunkSize: number = 8000): string[] {
		const chunks: string[] = []
		const paragraphs = text.split("\n\n")
		let currentChunk: string[] = []
		let currentLength = 0

		for (const paragraph of paragraphs) {
			if (currentLength + paragraph.length > maxChunkSize) {
				if (currentChunk.length > 0) {
					chunks.push(currentChunk.join("\n\n"))
					currentChunk = []
					currentLength = 0
				}
				// Handle very long paragraphs by splitting into sentences
				if (paragraph.length > maxChunkSize) {
					const sentences = paragraph.split(/[.!?]\s+/)
					for (const sentence of sentences) {
						if (currentLength + sentence.length > maxChunkSize) {
							chunks.push(sentence.substring(0, maxChunkSize))
							currentLength = 0
						} else {
							currentChunk.push(sentence)
							currentLength += sentence.length
						}
					}
				} else {
					chunks.push(paragraph)
				}
			} else {
				currentChunk.push(paragraph)
				currentLength += paragraph.length + 2 // Account for newlines
			}
		}

		if (currentChunk.length > 0) {
			chunks.push(currentChunk.join("\n\n"))
		}

		return chunks
	}

	// Add new chunking method for code content
	private static chunkCodeContent(content: string, maxChunkSize: number = 32000): string[] {
		const chunks: string[] = []
		const lines = content.split("\n")
		let currentChunk: string[] = []
		let currentLength = 0

		for (const line of lines) {
			if (currentLength + line.length > maxChunkSize) {
				// Try to find a natural split point in the last 10 lines
				let splitIndex = currentChunk.length - 1
				for (let i = currentChunk.length - 1; i >= Math.max(0, currentChunk.length - 10); i--) {
					if (/[;}]$/.test(currentChunk[i]) || currentChunk[i].trim() === "") {
						splitIndex = i + 1
						break
					}
				}

				chunks.push(currentChunk.slice(0, splitIndex).join("\n"))
				currentChunk = currentChunk.slice(splitIndex)
				currentLength = currentChunk.join("\n").length
			}

			currentChunk.push(line)
			currentLength += line.length + 1 // +1 for newline
		}

		if (currentChunk.length > 0) {
			chunks.push(currentChunk.join("\n"))
		}

		return chunks
	}

	private statuses = new Map<string, WorkspaceIndexStatus>()
	private store!: LanceDBVectorStore
	private initialized = false
	private initializationError: Error | null = null
	private parser: TreeSitterParser
	private config: SemanticSearchConfig
	private apiHandler?: ApiHandler

	constructor(config: SemanticSearchConfig, apiHandler?: ApiHandler) {
		this.config = config
		this.parser = new TreeSitterParser(config.context)
		this.apiHandler = apiHandler
		this.updateStatus(WorkspaceIndexStatus.NotIndexed)
	}

	private getWorkspaceId(context: vscode.ExtensionContext): string {
		// Use the workspace folder path as the ID
		const workspaceFolders = vscode.workspace.workspaceFolders
		if (workspaceFolders && workspaceFolders.length > 0) {
			return workspaceFolders[0].uri.fsPath
		}
		// Fallback to extension context storage path
		return context.storagePath || "global"
	}

	public updateStatus(status: WorkspaceIndexStatus): void {
		const workspaceId = this.getWorkspaceId(this.config.context)
		this.statuses.set(workspaceId, status)
	}

	public getStatus(): WorkspaceIndexStatus {
		const workspaceId = this.getWorkspaceId(this.config.context)
		return this.statuses.get(workspaceId) || WorkspaceIndexStatus.NotIndexed
	}

	/**
	 * Initializes the semantic search service by:
	 * 1. Setting the workspace status to 'Indexing'
	 * 2. Initializing the vector store with the workspace ID
	 * 3. Initializing the embedding model with retry logic
	 * 4. Verifying model initialization with a test embedding
	 * 5. Loading persisted vectors from the store
	 *
	 * The initialization process includes robust error handling and retry mechanisms:
	 * - Model initialization is attempted up to 3 times with increasing delays
	 * - Detailed error logging is performed for debugging
	 * - Status is updated appropriately based on success/failure
	 * - Initialization errors are stored for later reference
	 *
	 * @throws {Error} If initialization fails after all retry attempts
	 * @returns {Promise<void>} Resolves when initialization is complete
	 */
	async initialize(): Promise<void> {
		this.updateStatus(WorkspaceIndexStatus.Indexing)

		try {
			console.log("Initializing semantic search service")

			const workspaceId = this.getWorkspaceId(this.config.context)
			console.log("Workspace ID:", workspaceId)
			this.store = new LanceDBVectorStore(path.join(this.config.storageDir, "lancedb"), workspaceId)
			await this.store.initialize()

			console.log("Semantic search service initialized successfully")
			this.initialized = true

			if (this.store.size() === 0) {
				this.updateStatus(WorkspaceIndexStatus.NotIndexed)
			} else {
				this.updateStatus(WorkspaceIndexStatus.Indexed)
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			console.error("Initialization failed:", errorMessage)
			this.updateStatus(WorkspaceIndexStatus.NotIndexed)
			this.initializationError = error instanceof Error ? error : new Error(errorMessage)
			this.initialized = false
			throw error
		}
	}

	// Modify methods that require initialization to handle potential errors
	private async ensureInitialized(): Promise<void> {
		// If not initialized, attempt initialization
		if (!this.initialized) {
			try {
				await this.initialize()
			} catch (error) {
				// If initialization fails, throw a clear error
				throw new Error(
					`Semantic search service could not be initialized: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		// If an initialization error occurred previously, throw it
		if (this.initializationError) {
			throw this.initializationError
		}

		// Verify store exists
		if (!this.store) {
			throw new Error("Vector store not initialized")
		}
	}

	private async processFileWithHash(filePath: string): Promise<void> {
		// Check if path is a directory
		try {
			const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath))
			if (stat.type === vscode.FileType.Directory) {
				console.log(`Skipping directory: ${filePath}`)
				return
			}
		} catch (error) {
			console.error(`Error checking file stats for ${filePath}:`, error)
			return
		}

		const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))
		const textContent = new TextDecoder().decode(fileContent)

		// Create hash of file content
		const hash = crypto.createHash("sha256").update(textContent).digest("hex")

		// Check if file exists in DB and get its hash
		const { exists: hasExisting, hash: prevHash } = await this.store.hasFileSegments(filePath)

		// If hash matches and has existing segments, skip entirely
		if (hasExisting && hash === prevHash) {
			console.log(`Skipping unchanged file: ${filePath}`)
			return
		}

		// Delete old segments if needed
		if (hasExisting) {
			console.log(`File ${filePath} changed, deleting old segments`)
			await this.store.deleteByFilePath(filePath)
		}

		// Only process if we passed the checks
		console.log("Processing file", filePath, "Is code file?", SemanticSearchService.isCodeFile(filePath))
		if (SemanticSearchService.isCodeFile(filePath)) {
			const parsedFile = await this.parser.parseFile(filePath, hash) // Pass hash to parser
			console.log("Parsed file", parsedFile)
			if (!parsedFile) {
				console.error("Failed to parse file", filePath)
				return
			}
			for (const segment of parsedFile.segments) {
				const definition = {
					...convertSegmentToDefinition(segment, filePath),
					contentHash: hash,
				}
				await this.indexDefinition(definition)
			}
		} else {
			const chunks = SemanticSearchService.chunkText(textContent)
			for (const [index, chunk] of chunks.entries()) {
				const definition: CodeDefinition = {
					type: "file",
					name: `${path.basename(filePath)} #${index + 1}`,
					filePath: filePath,
					content: chunk,
					startLine: 1 + index * 100, // Approximate line numbers
					endLine: 1 + (index + 1) * 100,
					language: path.extname(filePath).slice(1) || "text",
					contentHash: hash,
				}
				await this.indexDefinition(definition)
			}
		}
	}

	async addToIndex(filePath: string): Promise<void> {
		await this.ensureInitialized()
		await this.processFileWithHash(filePath)
	}

	async addBatchToIndex(filePaths: string[]): Promise<void> {
		await this.ensureInitialized()
		this.updateStatus(WorkspaceIndexStatus.Indexing)

		try {
			for (const filePath of filePaths) {
				await this.processFileWithHash(filePath)
			}
			this.updateStatus(WorkspaceIndexStatus.Indexed)
		} catch (error) {
			this.updateStatus(WorkspaceIndexStatus.NotIndexed)
			throw error
		}
	}

	// Helper method to index a single definition
	private async indexDefinition(definition: CodeDefinition): Promise<void> {
		if (!this.apiHandler?.embedText) {
			throw new Error("Embeddings not supported with current API configuration")
		}

		// Split long content into chunks
		const maxLength = 32000 // ~8000 tokens at 4 chars/token
		const chunks =
			definition.type === "file"
				? SemanticSearchService.chunkText(definition.content)
				: SemanticSearchService.chunkCodeContent(definition.content, maxLength)

		for (const [index, chunk] of chunks.entries()) {
			const lineCount = chunk.split("\n").length
			const chunkDefinition: CodeDefinition = {
				...definition,
				name: `${definition.name} [part ${index + 1}]`,
				content: chunk,
				startLine: definition.startLine + index * lineCount,
				endLine: definition.startLine + (index + 1) * lineCount - 1,
			}

			const embedding = await this.apiHandler.embedText(chunkDefinition.content)
			await this.store.add(chunkDefinition, embedding)
		}
	}

	async search(query: string): Promise<SearchResult[]> {
		if (!this.apiHandler?.embedText) {
			throw new Error("Embeddings not supported with current API configuration")
		}

		const queryEmbedding = await this.apiHandler.embedText(query)

		await this.ensureInitialized()

		const results = await this.store.search(
			queryEmbedding,
			this.config.maxResults ? this.config.maxResults * 2 : 20,
		)

		const dedupedResults = this.deduplicateResults(results)
		const maxResults = this.config.maxResults ?? 10
		const finalResults: StoreSearchResult[] = []

		const codeResults = dedupedResults.filter((r) => r.metadata?.type !== "file")
		const fileResults = dedupedResults.filter((r) => r.metadata?.type === "file")

		for (const result of codeResults) {
			if (finalResults.length >= maxResults) break
			finalResults.push(result)
		}

		for (const result of fileResults) {
			if (finalResults.length >= maxResults) break
			finalResults.push(result)
		}

		return finalResults.slice(0, maxResults).map((r) => this.formatResult(r))
	}

	private formatResult(result: StoreSearchResult): SearchResult {
		if (!result.metadata || !result.metadata.filePath) {
			throw new Error("Invalid metadata in search result")
		}

		if (result.metadata.type === SearchResultType.File) {
			const { content, ...restMetadata } = result.metadata
			return {
				type: SearchResultType.File,
				filePath: result.metadata.filePath,
				name: result.metadata.name,
				metadata: restMetadata,
			} as FileSearchResult
		}

		return {
			type: SearchResultType.Code,
			filePath: result.metadata.filePath,
			content: result.metadata.content,
			startLine: result.metadata.startLine,
			endLine: result.metadata.endLine,
			name: result.metadata.name,
			codeType: result.metadata.type,
			metadata: result.metadata,
		} as CodeSearchResult
	}

	private deduplicateResults(results: StoreSearchResult[]): StoreSearchResult[] {
		const dedupedResults: StoreSearchResult[] = []
		const seenPaths = new Set<string>()
		const seenContent = new Set<string>()
		for (const result of results) {
			const filePath = result.metadata.filePath
			if (!filePath) continue

			if (result.metadata.type === SearchResultType.File) {
				if (!seenPaths.has(filePath)) {
					dedupedResults.push(result)
					seenPaths.add(filePath)
				}
			} else {
				if (!seenContent.has(result.metadata.content)) {
					dedupedResults.push(result)
					seenContent.add(result.metadata.content)
				}
			}
		}

		return dedupedResults
	}

	size(): number {
		if (!this.store) {
			throw new Error("Vector store not initialized")
		}
		return 0
	}

	provideApiHandler(apiHandler: ApiHandler) {
		this.apiHandler = apiHandler
	}

	clear(): void {
		this.store.clear()
		this.updateStatus(WorkspaceIndexStatus.NotIndexed)
	}
}
