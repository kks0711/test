import sys; sys.path.insert(0,'.')
from deck1_chojeo import *
d=Deck('REBUILDER_통일교육_초등저학년','초등 저학년',PARTS,FS,PAL)
print(build(d,S,'../decks')); print('\n'.join(w for w in WARN if '380' not in w))
