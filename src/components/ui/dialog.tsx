import * as React from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
}

export function Dialog({ open, onClose, title, children }: DialogProps) {
  if (!open) return null

  return (
    <div className='fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4'>
      <button className='absolute inset-0 bg-black/40 backdrop-blur-sm' onClick={onClose} aria-label='Close modal' />
      <section className='relative z-10 w-full rounded-t-2xl border border-zinc-200 bg-white p-4 shadow-2xl sm:max-w-2xl sm:rounded-2xl sm:p-6 dark:border-zinc-800 dark:bg-zinc-900'>
        <header className='mb-4 flex items-center justify-between'>
          <h2 className='text-lg font-semibold text-zinc-900 dark:text-zinc-100'>{title}</h2>
          <Button variant='ghost' size='icon' onClick={onClose} aria-label='Close'>
            <X className='h-4 w-4' />
          </Button>
        </header>
        <div className={cn('max-h-[70vh] overflow-y-auto pr-1')}>{children}</div>
      </section>
    </div>
  )
}
