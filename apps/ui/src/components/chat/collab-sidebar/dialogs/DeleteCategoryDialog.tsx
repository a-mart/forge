import { useState } from 'react'
import { deleteCategory } from '@/lib/collaboration-api'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { CollaborationCategory } from '@forge/protocol'

interface DeleteCategoryDialogProps {
  open: boolean
  category: CollaborationCategory
  onClose: () => void
  onDeleted?: (categoryId: string) => void
}

export function DeleteCategoryDialog({
  open,
  category,
  onClose,
  onDeleted,
}: DeleteCategoryDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleDelete = async () => {
    if (isDeleting) {
      return
    }

    setIsDeleting(true)
    setError(null)
    try {
      await deleteCategory(category.categoryId)
      onDeleted?.(category.categoryId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete category')
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Category</AlertDialogTitle>
          <AlertDialogDescription>
            Delete “{category.name}”? Channels in this category will become uncategorized.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault()
              void handleDelete()
            }}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? 'Deleting…' : 'Delete category'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
