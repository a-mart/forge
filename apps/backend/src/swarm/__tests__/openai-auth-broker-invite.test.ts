import { describe, expect, it } from 'vitest'
import { OpenAIAuthBrokerInviteParseError, parseOpenAIAuthBrokerInvite } from '../openai-auth/openai-auth-broker-invite.js'

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

const payload = {
  v: 1,
  brokerUrl: 'https://broker.example.test',
  brokerId: 'broker_1',
  inviteId: 'inv_123',
  secret: 'invite_secret',
}

describe('parseOpenAIAuthBrokerInvite', () => {
  it('accepts secure setup links with fragment payloads', () => {
    const parsed = parseOpenAIAuthBrokerInvite(
      `https://broker.example.test/-/forge-auth/invite#forge_auth_broker=${encode(payload)}`,
    )

    expect(parsed).toEqual({
      brokerUrl: 'https://broker.example.test',
      brokerId: 'broker_1',
      inviteId: 'inv_123',
      secret: 'invite_secret',
    })
  })

  it('accepts decoded JSON blobs for paste flows', () => {
    expect(parseOpenAIAuthBrokerInvite(JSON.stringify(payload))).toMatchObject({
      brokerUrl: 'https://broker.example.test',
      inviteId: 'inv_123',
      secret: 'invite_secret',
    })
    expect(parseOpenAIAuthBrokerInvite(payload)).toMatchObject({ inviteId: 'inv_123' })
  })

  it('allows localhost HTTP invites for local development', () => {
    const local = { ...payload, brokerUrl: 'http://127.0.0.1:8787' }
    expect(parseOpenAIAuthBrokerInvite(
      `http://127.0.0.1:8787/-/forge-auth/invite#forge_auth_broker=${encode(local)}`,
    )).toMatchObject({ brokerUrl: 'http://127.0.0.1:8787' })
  })

  it('rejects raw tokens, non-http protocols, remote HTTP, and unsupported providers', () => {
    const rejected = [
      'fop_abcdefghijklmnopqrstuvwxyz',
      `ftp://broker.example.test/-/forge-auth/invite#forge_auth_broker=${encode(payload)}`,
      `http://broker.example.test/-/forge-auth/invite#forge_auth_broker=${encode({ ...payload, brokerUrl: 'http://broker.example.test' })}`,
      JSON.stringify({ ...payload, providers: ['anthropic'] }),
    ]

    for (const input of rejected) {
      expect(() => parseOpenAIAuthBrokerInvite(input)).toThrow(OpenAIAuthBrokerInviteParseError)
    }
  })

  it('rejects setup links whose visible origin does not match the embedded broker URL', () => {
    expect(() => parseOpenAIAuthBrokerInvite(
      `https://broker.example.test/-/forge-auth/invite#forge_auth_broker=${encode({ ...payload, brokerUrl: 'https://other.example.test' })}`,
    )).toThrow(OpenAIAuthBrokerInviteParseError)
  })
})
