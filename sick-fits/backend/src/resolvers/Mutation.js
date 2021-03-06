const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { randomBytes } = require('crypto')
const { promisify } = require('util')
const { transport, makeANiceEmail } = require('../mail')

const SALT_LENGTH = 10
const ONE_HOUR = 1000 * 60 * 60
const ONE_YEAR = 1000 * 60 * 60 * 24 * 365

const Mutations = {
  async createItem(parent, args, ctx, info) {
    // TODO check if they're logged in

    const item = await ctx.db.mutation.createItem(
      {
        data: {
          ...args
        }
      },
      info
    )

    return item
  },

  updateItem(parent, args, ctx, info) {
    // first take a copy of the updates
    const updates = { ...args }
    // remove the ID from the updates
    delete updates.id
    // run the update method
    return ctx.db.mutation.updateItem(
      {
        data: updates,
        where: {
          id: args.id
        }
      },
      info
    )
  },

  async deleteItem(parent, args, ctx, info) {
    const where = { id: args.id }
    // 1. Find the item
    const item = await ctx.db.query.item({ where }, `{ id title }`)
    // 2. Check if they have permissions
    // TODO
    // 3. Delete It!
    return ctx.db.mutation.deleteItem({ where }, info)
  },

  async signup(parent, args, ctx, info) {
    // lowercase the user email
    args.email = args.email.toLowerCase()
    // hash the password
    const password = await bcrypt.hash(args.password, SALT_LENGTH)
    // create the user in the db
    const user = await ctx.db.mutation.createUser(
      {
        data: {
          ...args,
          password,
          permissions: { set: ['USER'] }
        }
      },
      info
    )
    // create the JWT
    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET)
    // Set the jwt as a cookie on the response
    // httpOnly prevents JS from accessing token in the frontend
    ctx.response.cookie('token', token, {
      httpOnly: true,
      maxAge: ONE_YEAR
    })

    return user
  },

  async signin(parent, { email, password }, ctx, info) {
    // check if there is a user with that email
    const user = await ctx.db.query.user({ where: { email } })
    if (!user) {
      throw new Error(`No such user found for email ${email}`)
    }
    // check if the password is correct
    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      throw new Error('Invalid Password!')
    }
    // generate the jwt token
    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET)
    ctx.response.cookie('token', token, {
      httpOnly: true,
      maxAge: ONE_YEAR
    })

    return user
  },

  signout(parent, args, ctx, info) {
    ctx.response.clearCookie('token')
    return { message: 'Goodbye!' }
  },

  async requestReset(parent, { email }, ctx, info) {
    // 1. Check if this is a real user
    const user = await ctx.db.query.user({ where: { email } })
    if (!user) {
      throw new Error(`No such user found for email ${email}`)
    }

    // 2. Set a reset token and expiry on that user
    const randomBytesPromisified = promisify(randomBytes)
    const resetToken = (await randomBytesPromisified(20)).toString('hex')
    const resetTokenExpiry = Date.now() + ONE_HOUR // 1 hour from now
    const res = await ctx.db.mutation.updateUser({
      where: { email },
      data: { resetToken, resetTokenExpiry }
    })

    // 3. Email them that reset token
    const mailRes = await transport.sendMail({
      from: 'carlos+1@shiftlabny.com',
      to: user.email,
      subject: 'Your password reset token',
      html: makeANiceEmail(
        `Your password reset token is here
        \n\n
        <a href="${
          process.env.FRONTEND_URL
        }/reset?resetToken=${resetToken}">Click here to reset</a>`
      )
    })

    // 4. Return the message
    return { message: 'Thanks!' }
  },

  async resetPassword(parent, args, ctx, info) {
    // 1. check if the passwords match
    if (args.password !== args.confirmPassword) {
      throw new Error("Your passwords don't match!")
    }
    // 2. check if its a valid reset token & check if token is expired
    const [user] = await ctx.db.query.users({
      where: {
        resetToken: args.resetToken,
        resetTokenExpiry_gte: Date.now() - ONE_HOUR
      }
    })
    if (!user) {
      throw new Error('This token is either invalid or expired.')
    }
    // 3. hash their new password
    const password = await bcrypt.hash(args.password, SALT_LENGTH)
    // 4. Save the new password to the user and remove old resetToken fields
    const updatedUser = await ctx.db.mutation.updateUser({
      where: { email: user.email },
      data: {
        password,
        resetToken: null,
        resetTokenExpiry: null
      }
    })
    // 5. Generate JWT
    const token = jwt.sign({ userId: updatedUser.id }, process.env.APP_SECRET)
    // 6. Set the JWT cookie
    ctx.response.cookie('token', token, {
      httpOnly: true,
      maxAge: ONE_YEAR
    })
    // 7. Return the new user
    return updatedUser
  }
}

module.exports = Mutations
