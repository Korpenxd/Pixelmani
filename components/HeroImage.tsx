'use client'

import Image from 'next/image'
import { useState } from 'react'

type HeroImageProps = {
  src: string
}

export default function HeroImage({ src }: HeroImageProps) {
  const [loaded, setLoaded] = useState(false)

  return (
    <Image
      src={src}
      alt=""
      fill
      preload
      sizes="100vw"
      quality={85}
      onLoad={() => setLoaded(true)}
      style={{
        objectFit: 'cover',
        objectPosition: 'center',
        filter: 'brightness(0.55)',
        opacity: loaded ? 1 : 0,
        transform: loaded ? 'scale(1)' : 'scale(1.015)',
        transition:
          'opacity 0.7s ease, transform 1.2s ease',
        willChange: 'opacity, transform',
      }}
    />
  )
}