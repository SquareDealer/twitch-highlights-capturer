from hl_detector.irc import parse_privmsg


def test_parse_privmsg_with_tags():
    line = '@tmi-sent-ts=1700000000123;user-id=42 :nick!nick@nick.tmi.twitch.tv PRIVMSG #chan :АХАХА привет'
    assert parse_privmsg(line) == (1700000000123, '42', 'АХАХА привет')


def test_parse_privmsg_without_tags_uses_receive_time_and_nick():
    got = parse_privmsg(':nick!nick@nick.tmi.twitch.tv PRIVMSG #chan :hi there\r\n', now_ms=555)
    assert got == (555, 'nick', 'hi there')


def test_parse_privmsg_ignores_other_commands_and_garbage():
    assert parse_privmsg('PING :tmi.twitch.tv') is None
    assert parse_privmsg('@badges=;user-id=1 :tmi.twitch.tv USERNOTICE #chan :hello') is None
    assert parse_privmsg('') is None
    assert parse_privmsg(b'\xff'.decode('utf-8', 'replace')) is None
