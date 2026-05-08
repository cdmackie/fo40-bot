import discord
from discord import app_commands

from core import config

settings = config.load()


class NotModerator(app_commands.CheckFailure):
    """Raised when a slash command requires the moderator role."""


class NotFortyPlus(app_commands.CheckFailure):
    """Raised when a slash command requires the @40s role."""


def is_moderator(member: discord.Member) -> bool:
    """True if the member is a mod OR an admin. Admins inherit mod privileges."""
    mod_roles = {settings.moderator_role_id, settings.admin_role_id}
    return any(r.id in mod_roles for r in member.roles)


def is_admin(member: discord.Member) -> bool:
    return any(r.id == settings.admin_role_id for r in member.roles)


def is_forty_plus(member: discord.Member) -> bool:
    return any(r.id == settings.forty_plus_role_id for r in member.roles)


def mod_only():
    """Decorator: restrict a slash command to members with the moderator role."""
    async def predicate(interaction: discord.Interaction) -> bool:
        if not isinstance(interaction.user, discord.Member):
            raise NotModerator("Server-only command.")
        if not is_moderator(interaction.user):
            raise NotModerator("Mods or admins only.")
        return True
    return app_commands.check(predicate)


def forty_plus_only():
    """Decorator: restrict a slash command to members with the 40+ role."""
    async def predicate(interaction: discord.Interaction) -> bool:
        if not isinstance(interaction.user, discord.Member):
            raise NotFortyPlus("Server-only command.")
        if not is_forty_plus(interaction.user):
            raise NotFortyPlus("This requires the 40+ role.")
        return True
    return app_commands.check(predicate)
