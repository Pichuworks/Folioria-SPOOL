import { type SessionUser } from './auth.js'

export interface UserDto {
  id: string
  email: string
  username: string | null
  name: string
  contact_info: string | null
  role: string
  must_change_password: boolean
  email_verified: boolean
}

export const userDto = (u: SessionUser): UserDto => ({
  id: u.id,
  email: u.email,
  username: u.username,
  name: u.name,
  contact_info: u.contact_info,
  role: u.role,
  must_change_password: u.must_change_password !== 0,
  email_verified: u.email_verified_at != null,
})

export const USER_DTO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    username: { type: ['string', 'null'] },
    name: { type: 'string' },
    contact_info: { type: ['string', 'null'] },
    role: { type: 'string' },
    must_change_password: { type: 'boolean' },
    email_verified: { type: 'boolean' },
  },
}
