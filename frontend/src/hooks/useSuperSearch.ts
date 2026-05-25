import { useReducer, useCallback } from 'react'
import {
  fetchGraph,
  searchNumber,
  listCategories,
  fetchRelated,
  fetchPhaseFlow,
  Doc,
  RelatedDoc,
  Phase,
} from '../api'

export type SearchMode = 'keyword' | 'number' | 'category' | 'relation' | 'phase'

export interface SearchResult {
  type: 'doc' | 'relation' | 'phase' | 'category'
  id: string
  title: string
  preview: string
  relevance: number
  metadata: Record<string, any>
  docId?: string // For navigating to doc
  icon?: string // For visual differentiation
}

export interface SearchState {
  query: string
  mode: SearchMode
  results: SearchResult[]
  loading: boolean
  error: string | null
  timestamp: number
}

interface SearchAction {
  type: 'SET_QUERY' | 'SET_MODE' | 'SET_RESULTS' | 'SET_LOADING' | 'SET_ERROR' | 'RESET'
  payload?: any
}

function searchReducer(state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case 'SET_QUERY':
      return { ...state, query: action.payload }
    case 'SET_MODE':
      return { ...state, mode: action.payload, results: [] }
    case 'SET_RESULTS':
      return { ...state, results: action.payload, timestamp: Date.now() }
    case 'SET_LOADING':
      return { ...state, loading: action.payload }
    case 'SET_ERROR':
      return { ...state, error: action.payload }
    case 'RESET':
      return {
        query: '',
        mode: 'keyword',
        results: [],
        loading: false,
        error: null,
        timestamp: 0,
      }
    default:
      return state
  }
}

export function useSuperSearch(graphName: string) {
  const [state, dispatch] = useReducer(searchReducer, {
    query: '',
    mode: 'keyword',
    results: [],
    loading: false,
    error: null,
    timestamp: 0,
  })

  const setQuery = useCallback((query: string) => {
    dispatch({ type: 'SET_QUERY', payload: query })
  }, [])

  const setMode = useCallback((mode: SearchMode) => {
    dispatch({ type: 'SET_MODE', payload: mode })
  }, [])

  const setLoading = useCallback((loading: boolean) => {
    dispatch({ type: 'SET_LOADING', payload: loading })
  }, [])

  const setError = useCallback((error: string | null) => {
    dispatch({ type: 'SET_ERROR', payload: error })
  }, [])

  const setResults = useCallback((results: SearchResult[]) => {
    dispatch({ type: 'SET_RESULTS', payload: results })
  }, [])

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' })
  }, [])

  // Individual search implementations
  const searchByKeyword = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setResults([])
        setError(null)
        return
      }

      try {
        setLoading(true)
        setError(null)

        const graphData = await fetchGraph(graphName)
        const queryLower = query.toLowerCase()

        // Filter docs by name or summary match
        const matches: SearchResult[] = graphData.docs
          .map((doc) => {
            const nameMatch = doc.name.toLowerCase().includes(queryLower)
            const summaryMatch = doc.summary?.toLowerCase().includes(queryLower) || false
            const keywordMatch =
              doc.keywords?.some((k) => k.toLowerCase().includes(queryLower)) || false

            // Calculate relevance score
            let relevance = 0
            if (nameMatch) relevance += 3
            if (summaryMatch) relevance += 1
            if (keywordMatch) relevance += 2

            return {
              relevance,
              doc,
            }
          })
          .filter((m) => m.relevance > 0)
          .sort((a, b) => b.relevance - a.relevance)
          .slice(0, 30)
          .map((m) => ({
            type: 'doc' as const,
            id: m.doc.id,
            docId: m.doc.id,
            title: m.doc.name,
            preview: m.doc.summary || m.doc.preview || '(无预览)',
            relevance: m.relevance,
            metadata: {
              category: m.doc.category,
              size: m.doc.size,
              ext: m.doc.ext,
            },
            icon: '📄',
          }))

        setResults(matches)
        setLoading(false)
      } catch (err) {
        setError((err as Error).message || '搜索失败')
        setLoading(false)
      }
    },
    [graphName, setLoading, setError, setResults]
  )

  const searchByNumber = useCallback(
    async (query: string, tolerance: number = 0.001) => {
      if (!query.trim()) {
        setResults([])
        setError(null)
        return
      }

      try {
        setLoading(true)
        setError(null)

        const response = await searchNumber(graphName, query, tolerance, false)
        const graphData = await fetchGraph(graphName)

        // Create a map for quick doc lookup
        const docMap = new Map(graphData.docs.map((d) => [d.id, d]))

        // Convert grouped results to SearchResult[]
        const results: SearchResult[] = (response.groups || [])
          .slice(0, 20)
          .flatMap((group: any) =>
            group.docs?.map((docResult: any) => {
              const doc = docMap.get(docResult.doc_id)
              return {
                type: 'doc' as const,
                id: docResult.doc_id,
                docId: docResult.doc_id,
                title: doc?.name || docResult.doc_name || docResult.doc_id,
                preview:
                  docResult.numbers?.[0]?.context ||
                  `包含 ${docResult.count || 1} 个数字匹配`,
                relevance: docResult.count || 1,
                metadata: {
                  query,
                  count: docResult.count,
                  numbers: docResult.numbers?.slice(0, 3),
                },
                icon: '🔢',
              }
            }) || []
          )

        setResults(results)
        setLoading(false)
      } catch (err) {
        setError((err as Error).message || '数字搜索失败')
        setLoading(false)
      }
    },
    [graphName, setLoading, setError, setResults]
  )

  const searchByCategory = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setResults([])
        setError(null)
        return
      }

      try {
        setLoading(true)
        setError(null)

        const categories = await listCategories(graphName)
        const graphData = await fetchGraph(graphName)
        const queryLower = query.toLowerCase()

        // Find matching categories
        const matchingCategories = categories.categories.filter((c) =>
          c.name.toLowerCase().includes(queryLower)
        )

        // Get all docs in matching categories
        const results: SearchResult[] = matchingCategories
          .flatMap((category) => {
            const docsInCategory = graphData.docs.filter((d) => d.category === category.name)
            return docsInCategory.map((doc) => ({
              type: 'doc' as const,
              id: doc.id,
              docId: doc.id,
              title: doc.name,
              preview: `分类: ${category.name}`,
              relevance: 1,
              metadata: {
                category: category.name,
                count: docsInCategory.length,
              },
              icon: '🏷️',
            }))
          })
          .slice(0, 30)

        setResults(results)
        setLoading(false)
      } catch (err) {
        setError((err as Error).message || '分类搜索失败')
        setLoading(false)
      }
    },
    [graphName, setLoading, setError, setResults]
  )

  const searchByRelation = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setResults([])
        setError(null)
        return
      }

      try {
        setLoading(true)
        setError(null)

        const graphData = await fetchGraph(graphName)

        // Find starting document by name or ID
        const startDoc = graphData.docs.find(
          (d) => d.id === query || d.name.toLowerCase().includes(query.toLowerCase())
        )

        if (!startDoc) {
          setError('找不到起始文档')
          setLoading(false)
          return
        }

        // Fetch related documents
        const related = await fetchRelated(graphName, startDoc.id, 20)
        const docMap = new Map(graphData.docs.map((d) => [d.id, d]))

        const results: SearchResult[] = related
          .slice(0, 20)
          .map((rel) => {
            const doc = docMap.get(rel.doc_id)
            const reasons = rel.reasons?.map((r) => r.type).join(', ') || '关联'
            return {
              type: 'doc' as const,
              id: rel.doc_id,
              docId: rel.doc_id,
              title: rel.doc_name,
              preview: `关联: ${reasons}`,
              relevance: rel.score,
              metadata: {
                score: rel.score,
                reasons: rel.reasons,
                startDoc: startDoc.name,
              },
              icon: '🔗',
            }
          })

        setResults(results)
        setLoading(false)
      } catch (err) {
        setError((err as Error).message || '关联搜索失败')
        setLoading(false)
      }
    },
    [graphName, setLoading, setError, setResults]
  )

  const searchByPhase = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setResults([])
        setError(null)
        return
      }

      try {
        setLoading(true)
        setError(null)

        const graphData = await fetchGraph(graphName)
        const phases = graphData.phases || []
        const queryLower = query.toLowerCase()

        // Find matching phases (search in phase names)
        const findMatchingPhases = (phasesArray: Phase[]): Phase[] => {
          return phasesArray.filter((p) => {
            const nameMatch = p.name.toLowerCase().includes(queryLower)
            const childMatches = p.children ? findMatchingPhases(p.children) : []
            return nameMatch || childMatches.length > 0
          })
        }

        const matchingPhases = findMatchingPhases(phases)

        // Get all docs in matching phases (including children)
        const getPhaseDocsRecursive = (p: Phase): string[] => {
          let docs = [...p.doc_ids]
          if (p.children) {
            p.children.forEach((child) => {
              docs = docs.concat(getPhaseDocsRecursive(child))
            })
          }
          return docs
        }

        const docMap = new Map(graphData.docs.map((d) => [d.id, d]))
        const results: SearchResult[] = matchingPhases
          .flatMap((phase) => {
            const phaseDocIds = getPhaseDocsRecursive(phase)
            return phaseDocIds
              .slice(0, 10)
              .map((docId) => {
                const doc = docMap.get(docId)
                return {
                  type: 'doc' as const,
                  id: docId,
                  docId: docId,
                  title: doc?.name || docId,
                  preview: `阶段: ${phase.name}`,
                  relevance: 1,
                  metadata: {
                    phase: phase.name,
                    phaseId: phase.id,
                  },
                  icon: '📊',
                }
              })
              .filter((r) => r.title !== 'undefined')
          })
          .slice(0, 30)

        setResults(results)
        setLoading(false)
      } catch (err) {
        setError((err as Error).message || '阶段搜索失败')
        setLoading(false)
      }
    },
    [graphName, setLoading, setError, setResults]
  )

  // Main search dispatcher
  const executeSearch = useCallback(
    async (query: string, mode: SearchMode) => {
      setQuery(query)
      setMode(mode)

      switch (mode) {
        case 'keyword':
          return searchByKeyword(query)
        case 'number':
          return searchByNumber(query)
        case 'category':
          return searchByCategory(query)
        case 'relation':
          return searchByRelation(query)
        case 'phase':
          return searchByPhase(query)
      }
    },
    [setQuery, setMode, searchByKeyword, searchByNumber, searchByCategory, searchByRelation, searchByPhase]
  )

  return {
    state,
    setQuery,
    setMode,
    setResults,
    setLoading,
    setError,
    reset,
    executeSearch,
  }
}
