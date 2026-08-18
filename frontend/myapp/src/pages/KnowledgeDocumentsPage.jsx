import * as React from "react"
import { RefreshCw } from "lucide-react"
import { KnowledgeDocumentTable } from "@/features/knowledge-admin/components/KnowledgeDocumentTable"
import { KnowledgeUploadCard } from "@/features/knowledge-admin/components/KnowledgeUploadCard"
import { useKnowledgeDocuments } from "@/features/knowledge-admin/hooks/useKnowledgeDocuments"
import { GlassPanel } from "@/shared/ui/GlassPanel"
import { PageWorkband } from "@/shared/ui/PageWorkband"
import { PageWorkbandInfoCard } from "@/shared/ui/PageWorkbandInfoCard"

export function KnowledgeDocumentsPage() {
  const {
    deleteDocument,
    documents,
    error,
    filters,
    loading,
    page,
    pageSize,
    refresh,
    setFilters,
    setPage,
    setPageSize,
    total,
    uploadDocument,
  } = useKnowledgeDocuments()

  return (
    <div className="page-stack">
      <PageWorkband
        actions={
          <button className="secondary-action" disabled={loading} type="button" onClick={refresh}>
            <RefreshCw size={16} />
            刷新文档列表
          </button>
        }
        aside={
          <PageWorkbandInfoCard
            items={[
              { label: "当前页", value: `${documents.length} 份` },
              { label: "索引提示", value: "上传后需重建" },
            ]}
            label="文档态势"
            title="文档源与索引状态"
          />
        }
        compact
        description="管理文档源文件与索引状态。上传后需触发重建才可检索。"
        eyebrow="知识资产"
        title="知识库文档"
      />
      <KnowledgeUploadCard onUpload={uploadDocument} />
      <GlassPanel aria-label="筛选" className="toolbar-surface">
        <section className="toolbar-panel">
          <label>
            关键词
            <input
              aria-label="关键词筛选"
              type="text"
              value={filters.keyword}
              onChange={(event) =>
                setFilters({
                  keyword: event.target.value,
                })
              }
            />
          </label>
          <label>
            状态
            <select
              aria-label="状态筛选"
              value={filters.status}
              onChange={(event) =>
                setFilters({
                  status: event.target.value,
                })
              }
            >
              <option value="">全部</option>
              <option value="active">active</option>
              <option value="deleted">deleted</option>
            </select>
          </label>
          <button disabled={loading} type="button" onClick={refresh}>
            刷新
          </button>
        </section>
      </GlassPanel>
      {error ? <p role="alert">{error.message}</p> : null}
      <KnowledgeDocumentTable
        documents={documents}
        onDeleteDocument={deleteDocument}
        onPageChange={setPage}
        onPageSizeChange={(nextPageSize) => {
          setPage(1)
          setPageSize(nextPageSize)
        }}
        page={page}
        pageSize={pageSize}
        total={total}
      />
    </div>
  )
}
